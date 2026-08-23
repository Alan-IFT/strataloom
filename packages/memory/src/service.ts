/**
 * MemoryService (`ctx.memory`) — the single permission execution point (D1)
 * and the single authoritative write entry `commitL1Mutation` (D4).
 * @module @strataloom/dsh-memory/service
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isLineagePrincipal, isLiveAgent } from './identity.ts'
import { deriveRepoIdentity } from './store/repo-key.ts'
import { GLOBAL_STORE_KEY } from './store/store.ts'
import type { OpenStore, StoreRegistry } from './store/store.ts'
import { queryRecallRows, querySimilarRows } from './store/fts.ts'
import { readSessionTurns } from './store/conversations.ts'
import { looksSecret, projectStore, PROJECTION_DIR, PROJECTION_FILE } from './projection.ts'
import { deriveWorkspaceRoot } from './store/repo-key.ts'
import type { TranscriptEvent } from './transcript.ts'
import {
  BODY_MAX_CHARS,
  TITLE_MAX_CHARS,
  SIMILAR_LIMIT,
} from './constants.ts'
import type {
  ForgetReport,
  MemoryCandidate,
  MemoryId,
  MemoryHit,
  ProposeResult,
  ShareReport,
  RecallQuery,
  RecallResult,
} from './types.ts'
import { LAYER, MEMORY_KINDS } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Typed, model-readable refusal (tools surface `message` verbatim). */
export class MemoryAccessError extends Error {
  override name = 'MemoryAccessError'
}

/** Typed validation failure (bad candidate content, unknown id …). */
export class MemoryInputError extends Error {
  override name = 'MemoryInputError'
}

const PRINCIPAL_ONLY =
  'only the top-level principal agent may do this; subagents and forked former ' +
  'subagents are read-only (use memory_recall)'

/**
 * commitL1Mutation (spec §3.3): every authoritative change goes through one
 * immediate transaction on one store. The store's `tx` IS the BEGIN
 * IMMEDIATE wrapper; this alias exists so call sites say what they mean.
 *
 * It no longer retires the derived summary by hand. That was a write-path
 * responsibility, and the pipeline commits through `commitClaimedJob` instead
 * — so reconcile and decay changed the authoritative set while a stale rollup
 * kept shadowing it. Schema v5 states the rule once, in SQL, over the data:
 * any change to a non-derived row invalidates, whichever entry wrote it.
 */
export const commitL1Mutation = <T>(store: OpenStore, mutate: () => T): T => store.tx(mutate)

/** Public memory service (spec §3.1). */
export class MemoryService extends Service {
  constructor(
    ctx: Context,
    private readonly stores: StoreRegistry,
  ) {
    super(ctx, 'memory')
  }

  /**
   * Resolve the agent's repo store. Only `session.header.cwd` counts —
   * absence means no repo affiliation: refuse writes, empty reads
   * (spec §2.1; never process.cwd()).
   */
  storeFor(agent: Agent, openIfMissing: boolean): OpenStore | undefined {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const identity = deriveRepoIdentity(cwd)
    if (identity === undefined) return undefined
    const open = this.stores.get(identity.key)
    if (open !== undefined) return open
    if (!openIfMissing) return undefined
    return this.stores.open(identity.key, identity.source)
  }

  /**
   * The cross-repo (private) store — Personal Memory's home. It has no repo
   * affiliation requirement: a preference about how to work with the user
   * holds in every checkout, including sessions with no git tree at all.
   */
  globalStore(openIfMissing: boolean): OpenStore | undefined {
    const open = this.stores.get(GLOBAL_STORE_KEY)
    if (open !== undefined) return open
    return openIfMissing ? this.stores.openGlobal() : undefined
  }

  /**
   * Both stores a given agent can read, nearest scope first. Repo memories
   * outrank personal ones on ties because the more specific context wins.
   */
  private readableStores(agent: Agent, openIfMissing: boolean): OpenStore[] {
    return [this.storeFor(agent, openIfMissing), this.globalStore(openIfMissing)].filter(
      (store) => store !== undefined,
    )
  }

  /** Both predicates must hold for any write (spec §3.1). */
  private assertPrincipal(agent: Agent): void {
    if (!isLiveAgent(this.ctx, agent)) {
      throw new MemoryAccessError('agent is not live in this registry')
    }
    if (!isLineagePrincipal(agent)) {
      throw new MemoryAccessError(PRINCIPAL_ONLY)
    }
  }

  /**
   * Recall — audience: any live agent; hit scope covers every provenance
   * minus excluded statuses (spec §2.3). Reads never trigger authoritative
   * change (D4): the usage counter is a non-authoritative table and its
   * update failure must never fail the read.
   */
  async recall(query: RecallQuery, agent: Agent): Promise<RecallResult> {
    if (!isLiveAgent(this.ctx, agent)) {
      throw new MemoryAccessError('agent is not live in this registry')
    }
    const text = query.query.trim()
    if (text === '') throw new MemoryInputError('query must be non-empty')
    if (query.kind !== undefined && !MEMORY_KINDS.includes(query.kind)) {
      throw new MemoryInputError(`unknown kind ${JSON.stringify(query.kind)}`)
    }
    // Recall spans both scopes: the user's durable preferences are as
    // relevant as this repo's facts, and the caller should not have to know
    // which store holds which.
    const hits: MemoryHit[] = []
    for (const store of this.readableStores(agent, true)) {
      const found = queryRecallRows(store, text, query.kind)
      this.touchUsage(store, found)
      hits.push(...found)
    }
    return { hits }
  }

  /**
   * Non-authoritative usage counters. This is the one write on a read path
   * (D4 permits it because `usage` is not authoritative state), so it takes a
   * WAL write lock: the spec puts it under slow-statement warning coverage
   * (§13). Any failure is swallowed — a counter must never fail a read.
   */
  private touchUsage(store: OpenStore, rows: readonly MemoryHit[]): void {
    if (rows.length === 0) return
    try {
      const now = Date.now()
      const stmt = store.db.prepare(
        `INSERT INTO usage (memory_id, retrieved, last_hit_at) VALUES (?, 1, ?)
         ON CONFLICT(memory_id) DO UPDATE
         SET retrieved = retrieved + 1, last_hit_at = excluded.last_hit_at`,
      )
      store.timed('recall-usage', () =>
        store.tx(() => {
          for (const row of rows) stmt.run(row.id, now)
        }),
      )
    } catch (error) {
      this.ctx.logger.warn('strataloom: usage update failed (read unaffected):', error)
    }
  }

  /**
   * The conversation behind one memory (L0 drill-down). Returns the stored
   * turns of the session that memory cites — the "show me the original
   * words" path that makes provenance checkable rather than merely claimed.
   *
   * This is a MODE of recall, not a fourth tool: "what was actually said" is
   * a narrowing of "what do we know", and the spec rejects growing the tool
   * surface for it.
   */
  async source(id: MemoryId, agent: Agent, limit: number): Promise<readonly TranscriptEvent[]> {
    if (!isLiveAgent(this.ctx, agent)) {
      throw new MemoryAccessError('agent is not live in this registry')
    }
    const stores = this.readableStores(agent, true)
    for (const store of stores) {
      const cited = store.db
        .prepare(
          `SELECT e.ref FROM evidence e JOIN memories m ON m.id = e.memory_id
           WHERE e.memory_id = ? AND e.kind = 'session' AND m.status != 'tombstone'
           LIMIT 1`,
        )
        .get(id) as { ref: string } | undefined
      if (cited === undefined) continue
      // A personal memory can cite a session whose transcript lives in the
      // repo store, so look for the turns in every readable store.
      for (const source of stores) {
        const turns = readSessionTurns(source, cited.ref, limit)
        if (turns.length > 0) return turns
      }
      return [] // cited, but the conversation has aged out of retention
    }
    throw new MemoryInputError(`no memory with id ${id}, or it was forgotten`)
  }

  /**
   * Propose (spec §3.3/§2.2): principal ⇒ synchronous active with
   * provenance `principal-explicit` and a session evidence row in the SAME
   * transaction (D3 — the propose origin is auditable from day one).
   * Non-principal ⇒ refused in P0 semantics; the candidate path arrives with
   * the pipeline's own writer (extract), not with tool-facing propose —
   * subagent tool calls get a clear refusal either way (spec §7).
   *
   * `replaces` supersedes an existing memory in one transaction: the caller
   * model has the existing entries in front of it (injected or recalled), so
   * it decides equivalence — code does not guess at semantics, and no second
   * LLM call is spent re-deciding what the caller already knows.
   */
  async propose(candidate: MemoryCandidate, agent: Agent): Promise<ProposeResult> {
    this.assertPrincipal(agent)
    const title = candidate.title.trim()
    const body = candidate.body.trim()
    if (title === '' || title.length > TITLE_MAX_CHARS) {
      throw new MemoryInputError(`title must be 1..${TITLE_MAX_CHARS} chars`)
    }
    if (body === '' || body.length > BODY_MAX_CHARS) {
      throw new MemoryInputError(`body must be 1..${BODY_MAX_CHARS} chars`)
    }
    if (!MEMORY_KINDS.includes(candidate.kind)) {
      throw new MemoryInputError(`unknown kind ${JSON.stringify(candidate.kind)}`)
    }
    // Scope is the caller's declared intent; visibility is derived from the
    // store that intent selects, never accepted from the caller (D1/D2).
    const personal = candidate.scope === 'personal'
    const store = personal ? this.globalStore(true) : this.storeFor(agent, true)
    if (store === undefined) {
      throw new MemoryAccessError(
        'this session has no repo affiliation (no validated cwd inside a git work tree); ' +
          "nothing was saved. Use scope 'personal' for memories that apply everywhere.",
      )
    }
    const id = randomUUID() as string as MemoryId
    const now = Date.now()
    commitL1Mutation(store, () => {
      // Insert before superseding: `superseded_by` is a foreign key, so the
      // replacement row must exist before anything can point at it. Both
      // happen in one transaction, so a crash leaves neither.
      store.db
        .prepare(
          `INSERT INTO memories
             (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, 'principal-explicit', ?, ?)`,
        )
        .run(id, candidate.kind, personal ? 'private' : 'repo-local', title, body, now, now)
      if (candidate.replaces !== undefined) {
        const changed = store.db
          .prepare(
            `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(id, now, candidate.replaces)
        if (Number(changed.changes) !== 1) {
          // Rolls back the insert too — no orphan replacement survives.
          throw new MemoryInputError(
            `cannot replace ${candidate.replaces}: no active memory with that id in this scope`,
          )
        }
      }
      store.db
        .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES (?, 'session', ?)`)
        .run(id, agent.session.id)
    })
    // Offer near-duplicates back. The model sees what already covers this
    // ground and can collapse it with `replaces` on the next save — the
    // judgement stays with the model, the bookkeeping with the code.
    const similar = candidate.replaces === undefined
      ? querySimilarRows(store, title, candidate.kind, SIMILAR_LIMIT).filter(
          (hit) => hit.id !== id,
        )
      : []
    return { id, similar }
  }

  /**
   * Promote one memory to team-shareable and project it into the workspace
   * (spec §12). Gated by the platform approval service: a model can propose
   * sharing, only a human can grant it, and `human_confirmed` records that.
   *
   * Fail closed at every step — a missing answerer, a rejection, or a
   * cancelled turn all leave the memory private to this machine.
   */
  async share(id: MemoryId, agent: Agent): Promise<ShareReport> {
    this.assertPrincipal(agent)
    const store = this.storeFor(agent, true)
    if (store === undefined) {
      throw new MemoryAccessError('sharing needs a repo; personal memories are never projected')
    }
    const row = store.db
      .prepare(`SELECT title, body, status, derived FROM memories WHERE id = ?`)
      .get(id) as
      | { title: string; body: string; status: string; derived: number }
      | undefined
    if (row === undefined) throw new MemoryInputError(`no memory with id ${id} in this repository`)
    if (row.status !== 'active') throw new MemoryInputError(`memory ${id} is not active`)
    if (row.derived !== LAYER.RAW) throw new MemoryInputError(`${id} is a generated summary`)
    // Scan BEFORE asking: a human should never be prompted to approve
    // something that would be refused at write time anyway, and the row must
    // not be marked shareable on the strength of an approval we will not act
    // on. The projection re-scans as a backstop.
    if (looksSecret(`${row.title}\n${row.body}`)) {
      return {
        id,
        shared: false,
        note: `${id} looks like it contains a credential and was not shared. Store the ` +
          'secret in your secret manager and record only how to reach it.',
      }
    }

    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      throw new MemoryAccessError('sharing requires the approval service; nothing was shared')
    }
    const outcome = await approval.request({
      agent,
      toolName: 'memory_share',
      reason:
        `Commit this memory to ${PROJECTION_DIR}/ so it is shared with everyone ` +
        `working in this repository: "${row.title}"`,
    })
    if (outcome !== 'allowed-once') {
      return { id, shared: false, note: `sharing was not approved (${outcome}); nothing changed` }
    }

    commitL1Mutation(store, () => {
      store.db
        .prepare(
          `UPDATE memories SET visibility = 'team-shareable', human_confirmed = 1, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(Date.now(), id)
    })
    // cwd is present: `storeFor` already required a repo to reach this point.
    const workspace = deriveWorkspaceRoot(agent.session.header.cwd ?? '')
    const written =
      workspace === undefined ? 0 : projectStore(store, workspace).written
    return {
      id,
      shared: true,
      note:
        `Shared. ${written} memory/memories now sit in ${PROJECTION_DIR}/${PROJECTION_FILE}; ` +
        'commit that file to share them with your team.',
    }
  }

  /**
   * Forget (spec §6, D5): tombstone + clear title/body/excerpts, KEEP
   * evidence refs (source suppression). Read surfaces close at commit —
   * no cache, no invalidation delay.
   */
  async forget(id: MemoryId, agent: Agent): Promise<ForgetReport> {
    this.assertPrincipal(agent)
    // Ids are unique across stores, so the caller forgets by id without
    // knowing (or being able to misstate) which scope holds it.
    const store = this.readableStores(agent, true).find(
      (candidate) =>
        candidate.db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined,
    )
    if (store === undefined) throw new MemoryInputError(`no memory with id ${id}`)
    const suppressedRefs = commitL1Mutation(store, () => {
      const row = store.db
        .prepare(`SELECT status, derived FROM memories WHERE id = ?`)
        .get(id) as { status: string; derived: number } | undefined
      if (row === undefined) throw new MemoryInputError(`no memory with id ${id}`)
      if (row.derived !== LAYER.RAW) {
        // A rollup has no independent existence: forgetting it would be
        // undone by the next rebuild. Point the caller at the real source.
        throw new MemoryInputError(
          `${id} is a generated summary, not a stored memory. Forget the underlying ` +
            'memory instead (recall it to get its id).',
        )
      }
      if (row.status === 'tombstone') throw new MemoryInputError(`memory ${id} is already forgotten`)
      store.db
        .prepare(
          `UPDATE memories SET status = 'tombstone', title = '', body = '', updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), id)
      store.db.prepare(`UPDATE evidence SET excerpt = NULL WHERE memory_id = ?`).run(id)
      const count = store.db
        .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ?`)
        .get(id) as { n: number }
      return count.n
    })
    return {
      id,
      suppressedRefs,
      note:
        `memory ${id} is tombstoned: it will not be recalled, injected, or re-learned from ` +
        `the same ${suppressedRefs} source ref(s). New evidence can re-learn it. ` +
        'Session logs and Git history are outside this capability and were not erased.',
    }
  }
}
