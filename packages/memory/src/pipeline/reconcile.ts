/**
 * Batch reconcile job (spec §3.4/§5.2): one extract's whole candidate batch,
 * one LLM call, one commit. Decisions per kind: fact — fresh evidence wins
 * (old superseded); procedure — versioned (old archived); preference — both
 * stay. The job decides keep/drop/replace only; content is the extract's.
 * @module @strataloom/dsh-memory/pipeline/reconcile
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OpenStore } from '../store/store.ts'
import type { MemoryKind } from '../types.ts'
import { RECONCILE_EXISTING_LIMIT } from '../constants.ts'
import { callPipelineLlm, parseStrictJson, PipelineLlmError, type PinnedRoute } from './llm-call.ts'
import { reconcileSystemPrompt } from './prompts.ts'
import { commitClaimedJob, type ClaimedJob } from './jobs.ts'
import type { ReconcilePayload } from './extract.ts'

interface CandidateRow {
  readonly id: string
  readonly kind: MemoryKind
  readonly title: string
  readonly body: string
}

/**
 * A validated decision. The union makes `supersedes` present exactly when the
 * action needs it, so the apply loop cannot forget the absent case — the
 * parser is the only place that check lives.
 */
type Decision = { readonly candidateIndex: number } & (
  | { readonly action: 'activate' | 'drop' }
  | { readonly action: 'supersede'; readonly supersedes: string }
)

const parseDecisions = (raw: unknown, count: number): Decision[] => {
  const root = raw as { decisions?: unknown }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.decisions)) {
    throw new PipelineLlmError('reply missing decisions array')
  }
  const seen = new Set<number>()
  const out: Decision[] = []
  for (const item of root.decisions) {
    const { candidateIndex: index, action, supersedes } = item as Record<string, unknown>
    if (
      typeof index !== 'number' ||
      index < 0 ||
      index >= count ||
      seen.has(index) ||
      (action !== 'activate' && action !== 'drop' && action !== 'supersede')
    ) {
      throw new PipelineLlmError('malformed decision in reply')
    }
    seen.add(index)
    if (action === 'supersede') {
      if (typeof supersedes !== 'string') {
        throw new PipelineLlmError('supersede decision missing supersedes id')
      }
      out.push({ candidateIndex: index, action, supersedes })
    } else {
      out.push({ candidateIndex: index, action })
    }
  }
  if (seen.size !== count) throw new PipelineLlmError('decisions must cover every candidate exactly once')
  return out
}

/**
 * Run one claimed reconcile job to its single commit. Candidates whose row
 * vanished (forgotten meanwhile) or whose decision no longer applies are
 * dropped silently — the durable state is authoritative, not the reply.
 */
export const runReconcileJob = async (
  ctx: Context,
  store: OpenStore,
  job: ClaimedJob,
  payload: ReconcilePayload,
  signal: AbortSignal,
): Promise<void> => {
  const fetchCandidate = store.db.prepare(
    `SELECT id, kind, title, body FROM memories WHERE id = ? AND status = 'candidate'`,
  )
  const candidates: CandidateRow[] = []
  for (const id of payload.candidateIds) {
    const row = fetchCandidate.get(id) as CandidateRow | undefined
    if (row !== undefined) candidates.push(row)
  }
  if (candidates.length === 0) {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return
  }

  const existing = store.db
    .prepare(
      `SELECT id, kind, title, body FROM memories
       WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(RECONCILE_EXISTING_LIMIT) as unknown as CandidateRow[]

  // Candidates are addressed by array index (their ids are internal and the
  // model has no use for them); existing rows keep their id because a
  // supersede decision must name one.
  const userPrompt = JSON.stringify({
    candidates: candidates.map(({ kind, title, body }) => ({ kind, title, body })),
    existing,
  })

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(ctx, route, reconcileSystemPrompt(), userPrompt, signal)
  const decisions = parseDecisions(parseStrictJson(reply), candidates.length)

  const now = Date.now()
  commitClaimedJob(store, job.id, job.leaseToken, () => {
    // Activation is a pure status flip: the extract model already wrote the
    // content and this job's question is only keep/drop/replace. Letting
    // reconcile reword would re-do finished semantic work (the same reason
    // explicit propose skips reconcile entirely, spec §3.3) and would need a
    // second copy of the truncation rules.
    const activate = store.db.prepare(
      `UPDATE memories SET status = 'active', updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    )
    const drop = store.db.prepare(
      `UPDATE memories SET status = 'superseded', updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    )
    const supersedeOld = store.db.prepare(
      `UPDATE memories SET status = ?, superseded_by = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    )
    for (const decision of decisions) {
      const candidate = candidates[decision.candidateIndex]
      if (candidate === undefined) continue
      if (decision.action === 'drop') {
        drop.run(now, candidate.id)
        continue
      }
      if (decision.action === 'supersede') {
        const oldRow = store.db
          .prepare(`SELECT kind, status FROM memories WHERE id = ?`)
          .get(decision.supersedes) as { kind: MemoryKind; status: string } | undefined
        // Two rules, stated so a new kind inherits one rather than needing a
        // branch: a `preference` is never superseded (only the user resolves
        // conflicting preferences, spec §3.4), and a vanished or inactive
        // target degrades to plain activation — durable state outranks the
        // reply. Everything else is replaced, and the replaced row is
        // `archived` when it was a `procedure` (superseding a procedure is
        // versioning — the old sequence still describes what used to work)
        // and `superseded` otherwise, including `coding`: a corrected
        // engineering lesson means the old one was wrong, not merely older.
        //
        // No cycle check is needed: `superseded_by` is only ever written on a
        // row leaving 'active', pointing at a row entering 'active' from
        // 'candidate', and nothing ever transitions back INTO 'candidate'.
        // Every id is written at most once, so the graph cannot close a loop.
        if (oldRow?.status === 'active' && oldRow.kind !== 'preference') {
          supersedeOld.run(
            oldRow.kind === 'procedure' ? 'archived' : 'superseded',
            candidate.id,
            now,
            decision.supersedes,
          )
        }
      }
      activate.run(now, candidate.id)
    }
  })
}
