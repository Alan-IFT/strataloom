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
import { queryAllMemories, queryRecallRows, querySimilarRows } from './store/fts.ts'
import { readSessionTurns } from './store/conversations.ts'
import { looksSecret, projectStore, PROJECTION_DIR, PROJECTION_FILE } from './projection.ts'
import { deriveWorkspaceRoot } from './store/repo-key.ts'
import {
  approvalReason,
  GROUP_FILE,
  readGroupDeclaration,
  resolveGroupMembers,
  type ResolvedMember,
} from './store/group.ts'
import type { TranscriptEvent } from './transcript.ts'
import {
  BODY_MAX_CHARS,
  TITLE_MAX_CHARS,
  SIMILAR_LIMIT,
  RECALL_FOREIGN_BUDGET_TOKENS,
  RECALL_RESULT_BUDGET_TOKENS,
} from './constants.ts'
import { withinBudget } from './recall/render.ts'
import type {
  ForgetReport,
  MemoryCandidate,
  MemoryId,
  MemoryHit,
  MemoryScopeListing,
  AttributedMemoryHit,
  ProposeResult,
  ShareReport,
  RecallQuery,
  RecallResult,
} from './types.ts'
import { LAYER, MEMORY_KINDS, MEMORY_SCOPES } from './types.ts'

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
  /**
   * Group state, created on first use rather than as class fields.
   *
   * Lazy because it must survive construction: the group paths are reached
   * from `recall`/`list`/`forget`, which several suites drive against a
   * service built by prototype-bypass (`Object.setPrototypeOf`, no constructor
   * run) — a field initializer would simply not exist there, and a read path
   * that throws `undefined.get` on an unusual construction is a worse failure
   * than the one it was meant to prevent. One accessor, so both pieces of
   * state are created together or not at all.
   *
   * `grants` holds approved `(session repo source, member-set fingerprint)`
   * pairs. Process-local and NEVER written into the repository: a trust
   * decision stored where an attacker can write is not a trust decision — a
   * checked-in grant file would let anyone who can open a pull request
   * pre-approve their own group. It is keyed on the ASKING repository as well
   * as the members, so a grant in one checkout is not a grant in another.
   *
   * `cache` holds resolved members per session and is also the TOCTOU
   * boundary: the declaration is read and approved once, and this holds the
   * very result that approval was granted against (see `resolveGroup`).
   */
  private group?: {
    readonly cache: Map<string, Promise<readonly ResolvedMember[]>>
    readonly grants: Set<string>
  }

  private groupState(): NonNullable<MemoryService['group']> {
    this.group ??= { cache: new Map(), grants: new Set() }
    return this.group
  }

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
   *
   * DELIBERATELY UNCHANGED by the group feature, and deliberately still
   * private. Four call sites share this one definition (`recall`, `list`,
   * `source`, `forget`), and they do not all want the same answer: `forget`
   * needs it to mean "stores this session may WRITE", which group members are
   * not. Widening it here would have silently granted cross-repository writes
   * from a read feature. Group membership is a separate, parallel accessor
   * (`groupMembers`) that each caller opts into explicitly.
   */
  private readableStores(agent: Agent, openIfMissing: boolean): OpenStore[] {
    return [this.storeFor(agent, openIfMissing), this.globalStore(openIfMissing)].filter(
      (store) => store !== undefined,
    )
  }

  /**
   * The group members this session may READ, in declaration order.
   *
   * Never includes the session's own store, never includes global, and never
   * opens anything. Empty unless a valid declaration exists AND a human
   * approved this exact (repository, member-set) pair in this session.
   *
   * Memoised per agent for the session's lifetime, which is also the TOCTOU
   * defence: the file is read ONCE, fingerprinted, approved against that
   * fingerprint, and the resolved members are what every later call uses. A
   * later edit to the declaration cannot take effect without a restart — which
   * is the point, not a limitation. Re-reading per call would reopen exactly
   * the window between "the human approved X" and "we act on Y" (the same rule
   * §2.1 states for migration: validate inside the lock).
   */
  private async groupMembers(agent: Agent): Promise<readonly ResolvedMember[]> {
    const { cache } = this.groupState()
    const cached = cache.get(agent.session.id)
    if (cached !== undefined) return cached
    const pending = this.resolveGroup(agent)
    cache.set(agent.session.id, pending)
    return pending
  }

  /** Foreign stores only — the shape the read paths consume. */
  private async groupStores(agent: Agent): Promise<readonly OpenStore[]> {
    return (await this.groupMembers(agent)).map((member) => member.store)
  }

  /**
   * Read → fingerprint → approve → resolve, once per session.
   *
   * Fail CLOSED on a missing approval service: unlike `llm` (whose absence
   * merely disables automatic extraction), approval is the only thing standing
   * between a declaration file and reading another repository's memories. A
   * degraded "no approver, so allow it" mode would make the file itself
   * sufficient authority, which is what the gate exists to prevent.
   *
   * Every other failure is fail-open-but-loud: no cwd, no declaration, a bad
   * declaration, or a rejected approval all leave this session behaving
   * exactly as it does without the feature.
   */
  private async resolveGroup(agent: Agent): Promise<readonly ResolvedMember[]> {
    try {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) return []
      const identity = deriveRepoIdentity(cwd)
      if (identity === undefined) return []
      const workspace = deriveWorkspaceRoot(cwd)
      if (workspace === undefined) return []
      // ONE read. `decl` is carried through approval and resolution unchanged;
      // nothing below touches the file again.
      const decl = readGroupDeclaration(workspace, this.ctx.logger)
      if (decl === undefined) return []
      const members = resolveGroupMembers(
        decl,
        this.stores,
        identity.key,
        workspace,
        this.ctx.logger,
      )
      if (members.length === 0) return []

      const approval = this.ctx.get('approval')
      if (approval === undefined) {
        this.ctx.logger.warn(
          `strataloom: ${GROUP_FILE} declares a group but the approval service is absent; ` +
            'the group is disabled (reading other repositories always requires a human)',
        )
        return []
      }
      // Authorization is keyed on (this repository, this member set): the same
      // members approved in repository A grant nothing in repository B,
      // because "who may read these" is a property of the ASKING side too.
      const grantKey = `${identity.source}\u0000${decl.fingerprint}`
      const { grants } = this.groupState()
      if (!grants.has(grantKey)) {
        const outcome = await approval.request({
          agent,
          toolName: 'memory_group',
          reason: approvalReason(decl, members),
        })
        if (outcome !== 'allowed-once') {
          this.ctx.logger.info(
            `strataloom: group "${decl.group}" was not approved (${outcome}); ` +
              'only this repository\'s memories are readable',
          )
          return []
        }
        grants.add(grantKey)
      }
      return members
    } catch (error) {
      // A group fault must never break recall: the session degrades to exactly
      // today's behaviour rather than failing.
      this.ctx.logger.warn('strataloom: group resolution failed (using this repo only):', error)
      return []
    }
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
   * Everything this session can see, newest first, grouped by the store it
   * came from — the "what have you been remembering about me?" question.
   *
   * A read, so it takes the same audience rule as `recall` (live agent, not
   * necessarily principal). It deliberately does NOT touch `usage`: listing is
   * browsing, not retrieval, and counting it would make decay think entries
   * were being used every time someone looked at the list.
   *
   * Unlike `recall` there is no query and no relevance ranking, because the
   * question is completeness rather than relevance. The cap exists so one very
   * large store cannot flood a caller, not to hide anything.
   */
  async list(agent: Agent, limit: number): Promise<readonly MemoryScopeListing[]> {
    if (!isLiveAgent(this.ctx, agent)) {
      throw new MemoryAccessError('agent is not live in this registry')
    }
    const repo = this.storeFor(agent, false)
    const personal = this.globalStore(false)
    const listings: MemoryScopeListing[] = []
    if (repo !== undefined) {
      listings.push({ scope: { kind: 'repo' }, memories: queryAllMemories(repo, limit) })
    }
    if (personal !== undefined) {
      listings.push({ scope: { kind: 'personal' }, memories: queryAllMemories(personal, limit) })
    }
    // One listing PER member, never merged into the repo listing. `limit` is a
    // per-scope cap (see LIST_LIMIT) and stays one: it exists so a single huge
    // store cannot flood a caller, and that reason applies per store. Merging
    // would answer "completeness" while destroying "whose is this?" — and the
    // only action this surface offers (`forget`) is refused for foreign rows,
    // so a person must be able to see which entries those are.
    for (const member of await this.groupMembers(agent)) {
      listings.push({
        scope: { kind: 'group', source: member.source, archived: member.archived },
        memories: queryAllMemories(member.store, limit),
      })
    }
    return listings
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
    // Home rows are collected first and then spent against their OWN budget.
    //
    // That budget used to be applied by the tool's renderer instead, which was
    // adequate only while home was the packet's sole occupant. It no longer is,
    // and leaving it there would make the load-time packet guard assert
    // something false: the guard prices home at RECALL_RESULT_BUDGET_TOKENS,
    // so home has to actually be bounded by it before the renderer sees it.
    // Measured without this clip, 20 home rows filled the whole packet and
    // foreign delivery returned to zero — the very defect being fixed, moved
    // one layer out rather than removed.
    //
    // The set is byte-identical to what the renderer used to select: the same
    // `withinBudget`, the same budget, the same `withId`, the same order. This
    // relocates where the rule runs, never what it decides.
    const homeFound: MemoryHit[] = []
    for (const store of this.readableStores(agent, true)) {
      const found = queryRecallRows(store, text, query.kind)
      // Usage is counted on what the STORE returned, exactly as before: this
      // clip changes rendering, and quietly narrowing the decay signal with it
      // would be an unrelated behaviour change smuggled in under a budget fix.
      this.touchUsage(store, found)
      homeFound.push(...found)
    }
    // No `source` on home rows: absence IS the statement "this repository's
    // own", and it is what keeps the no-group packet byte-identical (see
    // `AttributedMemoryHit`). Setting a home source and relying on the
    // renderer to special-case it would put the same rule in two places.
    const hits: AttributedMemoryHit[] = withinBudget(homeFound, RECALL_RESULT_BUDGET_TOKENS, true)
    // Group members come AFTER, each with its OWN budget, and are never merged
    // into the home ranking. Two measured facts force this shape:
    //
    // 1. A shared container lets foreign rows evict home rows — measured at
    //    33.1%-40.9% of queries before the split, which is ADR 0007's failure
    //    with new labels. Appending under separate budgets makes the home
    //    result a function of the home stores alone: replayed over 1412
    //    mechanically generated seeds, the home entries delivered are
    //    byte-identical with the group on and off (1401/1401).
    //
    // 2. FTS5 `rank` is NOT COMPARABLE ACROSS STORES. It is negative BM25, and
    //    BM25's IDF term is computed from each store's own N and df — so the
    //    more central a word is to a repository, the WORSE its rank there.
    //    Measured: 85.2% of queries (265/311) rank-invert against relevance.
    //    The concrete case: for 部署 the best `rank` belongs to the frontend
    //    repo with 1 incidental hit, while the operations repo that actually
    //    owns deployment (14 hits, df/N 42.4%) sorts LAST. Any global ORDER BY
    //    rank over merged rows therefore encodes the opposite of relevance,
    //    which is why ordering here is positional (home first, then members in
    //    declaration order) and never score-based.
    for (const member of await this.groupMembers(agent)) {
      // ATTRIBUTION is attached HERE, before the budget is spent, at the only
      // point in the system that still knows which store a row came from. One
      // line further on these rows are indistinguishable from home rows —
      // which is precisely the state the packet used to reach the model in,
      // under a header reading "in this repository".
      //
      // BEFORE the clip, not after, and that ordering is a correctness
      // requirement rather than a style choice: `withinBudget` prices through
      // the real `renderEntry`, so a label added afterwards would make every
      // admitted row larger than the budget was told it is — the D8 failure of
      // pricing a different string than the renderer emits, which this
      // codebase has already paid for twice. Labelled first, priced as
      // rendered.
      const found = queryRecallRows(member.store, text, query.kind).map((hit) => ({
        ...hit,
        source: member.source,
      }))
      // Priced with `withId` because that is how the recall tool renders, and
      // a budget that prices a different string than the renderer emits is the
      // D8 failure this codebase has already paid for twice.
      const admitted = withinBudget(found, RECALL_FOREIGN_BUDGET_TOKENS, true)
      // NO `touchUsage` HERE, and that absence is load-bearing. Read the
      // paragraph before deleting the comment or "restoring symmetry" with the
      // home loop twenty lines up.
      //
      // The previous revision DID touch it, defended by "usage is
      // non-authoritative (D4 permits a read-path write), and decay must see
      // these rows being used or the group would decay the memories it exists
      // to surface". Both halves were wrong, and measurement showed it.
      //
      // 1. IT IS NOT NON-AUTHORITATIVE ONCE IT CROSSES A REPOSITORY BOUNDARY.
      //    `usage` is an input to `pipeline/decay.ts`, whose module comment
      //    states the invariant this violated: "revival happens HERE, never on
      //    the read path, because a read must not cause an authoritative
      //    change (D4)". Decay reads `usage.last_hit_at` and writes
      //    `memories.status`, which IS authoritative. Inside one repository
      //    that chain is contained — the session that reads is the session
      //    that owns the store. Across repositories it is not: measured on
      //    copies of the real stores, a Backend store staged to 61 stale
      //    active rows slept ALL 61 when it decayed on its own, and only 57
      //    when a FullStack session ran 7 pure `recall` calls first — 4 rows
      //    kept `active` in ANOTHER repository by a read in this one, and all
      //    4 were rows this session had retrieved. A pure read here rewrote
      //    authoritative state there.
      //
      // 2. THE DECAY WORRY DOES NOT SURVIVE EITHER BRANCH. If the member
      //    repository has its own sessions, its own reads touch its own usage
      //    and decay already sees them — this loop adds nothing. If it has no
      //    sessions (the orphaned `…_Ops` store, no checkout on this machine),
      //    then decaying on its own schedule is the CORRECT behaviour, and
      //    propping it up with another repository's activity would keep an
      //    abandoned store artificially awake for as long as anyone, anywhere,
      //    keeps reading it. Measured: those writes reached that orphan too.
      //
      // 3. IT MADE THE APPROVAL PROMPT UNTRUE. `approvalReason` tells the
      //    human "Nothing is ever written to them", and that sentence is the
      //    load-bearing safety mechanism for a member whose `archived` claim
      //    code cannot verify (see store/group.ts). It was false: recall moved
      //    real bytes in the member's `memory.sqlite` (md5 and mtime both
      //    changed, measured). A person consented on the strength of that
      //    sentence, so the sentence is the specification and the code was the
      //    defect.
      //
      // The group is a READ scope. This line is where that stops being a claim
      // and becomes a property of the code.
      hits.push(...admitted)
    }
    return { hits }
  }

  /**
   * Usage counters for a store THIS SESSION OWNS. This is the one write on a
   * read path, so it takes a WAL write lock: the spec puts it under
   * slow-statement warning coverage (§13). Any failure is swallowed — a
   * counter must never fail a read.
   *
   * CALLABLE ONLY WITH `readableStores()` MEMBERS — this session's own repo
   * store and the global store. Never with a group member's store. The
   * qualifier is not stylistic: `usage` is only "non-authoritative" as long as
   * the thing that consumes it belongs to the same repository. `decay` turns
   * `usage.last_hit_at` into `memories.status`, so calling this on a foreign
   * store makes a read in THIS repository an authoritative write in ANOTHER
   * one, which is exactly what D4 forbids and what the approval prompt
   * promises does not happen. The measurement and the full argument are at the
   * member loop in `recall`, which is where the call used to be.
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
    // `source` follows `recall` exactly, because it IS a mode of recall (see
    // the note above): a memory this session can retrieve but whose evidence it
    // cannot open is a claim without provenance, which D3 forbids. Widening
    // recall without widening this would have shipped exactly that.
    const stores = [...this.readableStores(agent, true), ...(await this.groupStores(agent))]
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
    if (candidate.scope !== undefined && !MEMORY_SCOPES.includes(candidate.scope)) {
      throw new MemoryInputError(`unknown scope ${JSON.stringify(candidate.scope)}`)
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
    //
    // PINNED to `readableStores` — group members are deliberately NOT searched
    // here, and this comment is the only thing preventing a future "let's use
    // the same store list everywhere" tidy-up from turning a read feature into
    // a cross-repository WRITE capability.
    //
    // Two reasons, either sufficient:
    //   - D1 says a write always lands in the session's own repository. A
    //     cross-group forget is literally a write to another repository's
    //     store, in direct contradiction of that.
    //   - `recall` returns ids (`withId=true`, because forget needs them), so
    //     if this list included members, the read widening would convert
    //     directly into the power to destroy rows in repositories this session
    //     was only ever granted READ access to. The approval prompt says
    //     "nothing is ever written to them"; this line is what makes that true.
    const store = this.readableStores(agent, true).find(
      (candidate) =>
        candidate.db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined,
    )
    if (store === undefined) {
      // Before the generic "no such id", check whether it is a group member's
      // row: a caller who just recalled it needs to know it EXISTS and why it
      // cannot be forgotten here, not to be told it does not exist.
      const foreign = (await this.groupMembers(agent)).find(
        (member) =>
          member.store.db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined,
      )
      if (foreign !== undefined) {
        throw new MemoryInputError(
          `${id} belongs to group member repository ${foreign.source}, not to this session's ` +
            'repository. forget only acts on the repository this session is in. ' +
            (foreign.archived
              ? 'That repository is declared archived and has no checkout here, so there is ' +
                'currently no session from which it can be forgotten — this entry cannot be ' +
                'removed until a checkout of it exists again.'
              : `Start a session inside the ${foreign.source} checkout and retry there.`),
        )
      }
      throw new MemoryInputError(`no memory with id ${id}`)
    }
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
