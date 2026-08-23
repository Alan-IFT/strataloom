/**
 * The derived layer: L2 scenario blocks (spec §12, 4×4 phase 2).
 *
 * When direct L1 injection outgrows its budget, the packet silently truncates
 * — the model stops seeing memories nobody decided to drop. The fix is to
 * rebuild the working set into SCENARIO blocks: one LLM-written briefing per
 * piece of work someone would resume as a unit, each an ordinary row carrying
 * `derived = LAYER.SCENARIO`.
 *
 * Scenarios rather than one whole-store summary, because the layer exists to
 * restore a working context and a single briefing over everything restores
 * none of them well. A scenario is a topic, not a directory — it may span
 * several parts of the codebase — so the clustering is the model's judgement,
 * made once per rebuild and never on the read path.
 *
 * Two deliberate reductions against the archived design:
 *
 * 1. **No PacketCache.** That companion existed because "rebuild became
 *    LLM-priced". But the rollup is STORED, so the read path is still one
 *    millisecond-class SQL statement — the price is paid in a job, not on
 *    the read. A cache would be pure concept cost, exactly as v2.5 argued.
 * 2. **The layer switches itself on.** No config flag: rebuild is enqueued
 *    only while the measured packet exceeds its budget (§9's own indicator),
 *    and the rollup is dropped again once L1 fits. The feature's trigger
 *    condition IS its runtime condition.
 *
 * `store_revision` fences the work: a rollup built from a superseded
 * snapshot must never be committed. The check runs twice — after claiming
 * (so a stale job costs no LLM call) and again inside the commit.
 * @module @strataloom/dsh-memory/pipeline/rebuild
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { OpenStore } from '../store/store.ts'
import { commitClaimedJob, enqueueJob, jobId, type ClaimedJob } from './jobs.ts'
import {
  callPipelineLlm,
  parseStrictJson,
  PipelineLlmError,
  type PinnedRoute,
} from './llm-call.ts'
import { rollupSystemPrompt } from './prompts.ts'
import {
  INJECT_BODY_BUDGET_TOKENS,
  ROLLUP_MAX_SCENARIOS,
  ROLLUP_SOURCE_LIMIT,
  TITLE_MAX_CHARS,
  BODY_MAX_CHARS,
} from '../constants.ts'
import { LAYER } from '../types.ts'
import { queryInjectableSet } from '../store/fts.ts'
import { packetTokens } from '../recall/inject.ts'

/** Payload of one rebuild job: the snapshot it was queued for. */
export interface RebuildPayload {
  readonly expectedRevision: number
  readonly provider: string
  readonly model: string
}

/** Read the store's current snapshot revision (0 when never written). */
export const readRevision = (store: OpenStore): number => {
  const row = store.db.prepare(`SELECT v FROM meta WHERE k = 'store_revision'`).get() as
    | { v: string }
    | undefined
  return row === undefined ? 0 : Number(row.v)
}

/**
 * Whether direct injection currently overflows its budget — the measured
 * condition that both enables and disables the derived layer. Priced with
 * the packet's own estimator so the trigger means what the budget means.
 */
export const packetOverflows = (store: OpenStore): boolean =>
  packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)) > INJECT_BODY_BUDGET_TOKENS

/**
 * Queue a rebuild if — and only if — direct injection currently overflows.
 * The derived layer therefore switches itself on and off from measurement:
 * §9's indicator IS §12's trigger, so there is no flag to set and no state
 * to keep in sync. The revision rides the idempotence key, so a job for a
 * superseded snapshot is a different job (and is fenced when claimed).
 * @returns whether a rebuild was queued.
 */
export const enqueueRebuildIfOverflowing = (
  ctx: Context,
  store: OpenStore,
  now: number,
): boolean => {
  if (!packetOverflows(store)) return false
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection === undefined) return false // no route ⇒ no rollup, packet truncates
  const expectedRevision = readRevision(store)
  const payload: RebuildPayload = {
    expectedRevision,
    provider: selection.provider,
    model: selection.model,
  }
  enqueueJob(store, 'rebuild', jobId('rebuild', store.repoKey, expectedRevision), payload, now)
  return true
}

/**
 * Run one claimed rebuild job. Returns false when the job was fenced by the
 * revision precheck (no LLM call was made).
 */
export const runRebuildJob = async (
  ctx: Context,
  store: OpenStore,
  job: ClaimedJob,
  payload: RebuildPayload,
  signal: AbortSignal,
): Promise<boolean> => {
  // Precheck BEFORE the model call: a job queued for an older snapshot is
  // settled without burning tokens (spec §12: 不烧 LLM).
  if (readRevision(store) !== payload.expectedRevision) {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return false
  }
  // Re-check overflow against the rows we are about to summarize: the set
  // may have shrunk since the job was queued, and an empty set cannot
  // overflow, so one test covers both.
  const sources = queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)
  if (packetTokens(sources) <= INJECT_BODY_BUDGET_TOKENS) {
    // L1 fits again — no rollup needed, and any stale one is already gone.
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return false
  }

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(
    ctx,
    route,
    rollupSystemPrompt(),
    JSON.stringify({ memories: sources }),
    signal,
  )
  const scenarios = parseScenarios(parseStrictJson(reply))

  commitClaimedJob(store, job.id, job.leaseToken, () => {
    // Fence again inside the commit: the snapshot may have moved while the
    // model was answering.
    if (readRevision(store) !== payload.expectedRevision) return
    const now = Date.now()
    // Clear EVERY derived layer, not just this one: whatever is here was
    // built from the same snapshot, so it is replaced as a set.
    store.db.prepare(`DELETE FROM memories WHERE derived != ${LAYER.RAW}`).run()
    const insert = store.db.prepare(
      `INSERT INTO memories
         (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', ?, 'active', ?, ?, 'derived', ?, ?, ${LAYER.SCENARIO})`,
    )
    const visibility = store.kind === 'global' ? 'private' : 'repo-local'
    for (const scenario of scenarios) {
      insert.run(randomUUID(), visibility, scenario.title, scenario.body, now, now)
    }
  })
  return true
}

/** One scenario block as the model returns it, already bounded. */
interface Scenario {
  readonly title: string
  readonly body: string
}

/**
 * Validate the rollup reply into scenario blocks.
 *
 * Empty or malformed replies throw, reaching the runner's retry exit: a
 * rebuild that produced nothing must not commit, because committing zero
 * scenarios would look like "the packet fits now" and leave the overflowing
 * raw set injected in truncated form.
 */
const parseScenarios = (raw: unknown): Scenario[] => {
  const root = raw as { scenarios?: unknown }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.scenarios)) {
    throw new PipelineLlmError('rollup reply missing scenarios array')
  }
  const out: Scenario[] = []
  for (const item of root.scenarios.slice(0, ROLLUP_MAX_SCENARIOS)) {
    const scenario = item as Partial<Scenario>
    if (typeof scenario.title !== 'string' || typeof scenario.body !== 'string') {
      throw new PipelineLlmError('malformed scenario in rollup reply')
    }
    const title = scenario.title.trim().slice(0, TITLE_MAX_CHARS)
    const body = scenario.body.trim().slice(0, BODY_MAX_CHARS)
    if (title === '' || body === '') continue
    out.push({ title, body })
  }
  if (out.length === 0) throw new PipelineLlmError('rollup produced no usable scenario')
  return out
}
