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
import { personaSystemPrompt, rollupSystemPrompt } from './prompts.ts'
import {
  INJECT_BODY_BUDGET_TOKENS,
  PERSONA_SOURCE_LIMIT,
  ROLLUP_MAX_SCENARIOS,
  ROLLUP_SOURCE_LIMIT,
  ROLLUP_TRANSCRIPT_CHARS,
  ROLLUP_TITLE_TARGET_CHARS,
  PERSONA_MAX_TOKENS,
  SCENARIO_MAX_TOKENS,
  PERSONA_TITLE,
} from '../constants.ts'
import { DERIVED_PROVENANCE, LAYER, type MemoryHit } from '../types.ts'
import { queryInjectableSet } from '../store/fts.ts'
import { packetTokens } from '../recall/inject.ts'
import { truncatedToBudget } from '../recall/render.ts'

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
 * Whether the RAW set overflows the packet budget — the measured condition
 * that both enables and disables the derived layer. Priced with the packet's
 * own estimator so the trigger means what the budget means.
 *
 * The container is `queryInjectableSet` — the RAW set — and it has to stay that
 * way. Pricing `queryInjectionRows` instead (what injection actually carries)
 * reads like the more honest measurement and is a self-reference: once a
 * rollup exists, the trigger would be asking about the summary's own size,
 * which the summary is built to keep small, so it would answer "no" forever and
 * the blocks would go on describing a snapshot that has since moved.
 *
 * ## Why this container keeps the trigger alive, measured
 *
 * The RAW rows are not consumed by a rollup: the commit runs
 * `DELETE FROM memories WHERE derived != RAW`, which replaces the derived
 * layer and leaves every raw row in place. So the quantity this prices does not
 * shrink when a rollup succeeds, and the next snapshot is re-evaluated on the
 * same material. End to end through the real writer, 60 raw rows:
 *
 *     before rollup   raw set 4670 tok   -> packetOverflows true
 *     after  rollup   derived rows 6, injection 1038 tok
 *                     raw rows still 60, raw set still 4670 tok
 *                     -> packetOverflows STILL true
 *
 * An earlier revision of this comment argued the opposite — that the derived
 * layer's own cheapness would freeze the trigger permanently, and that the
 * store was saved only by two ESCAPE HATCHES (legacy oversized rows, and
 * conforming rows whose newline density outprices `DERIVED_WORST_LINE_CHARS`).
 * Both halves were wrong, and the correction is worth keeping because the shape
 * recurs: the argument reasoned about the wrong container. It priced the
 * derived rows, which is what `queryInjectionRows` would have measured, while
 * the code prices the raw set. There was never a freeze to escape.
 *
 * The second "escape hatch" is also gone on its own terms: the write path now
 * bounds a row by its RENDERED TOKENS (`SCENARIO_MAX_TOKENS` /
 * `PERSONA_MAX_TOKENS`, see `parseScenarios`), so a dense body is truncated to
 * fit rather than silently exceeding the budget. Nothing depends on that
 * change here — this trigger never looked at derived rows — which is precisely
 * why the unit change did not move it.
 *
 * Either way the trigger's question is about the material ("does the raw set
 * still need summarizing?"), and never about the summary's own size.
 *
 * `ROLLUP_SOURCE_LIMIT` rather than `INJECT_TOP_N` for the same reason: the
 * job summarizes the sources, so the test must see all of them.
 *
 * It must also stay the same container as `runRebuildJob`'s re-check below.
 * If enqueue and execution answered from different sets, one job could be
 * queued and then dismissed as unnecessary on arrival, forever.
 */
export const packetOverflows = (store: OpenStore): boolean =>
  packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)) > INJECT_BODY_BUDGET_TOKENS

/**
 * Queue a rebuild if — and only if — the raw set currently overflows. The
 * derived layer therefore switches itself on and off from measurement: there
 * is no flag to set and no state to keep in sync.
 *
 * §9's indicator and §12's trigger share one ruler — `packetTokens` — and
 * measure two different containers deliberately: `metrics.ts` prices what the
 * next assembly injects, this prices the raw set a rollup would consume. Same
 * rule, two execution points, which `constants.ts` distinguishes from a
 * duplicated rule; collapsing them into one container is the self-reference
 * described on `packetOverflows`. The revision rides the idempotence key, so a
 * job for a superseded snapshot is a different job (and is fenced when
 * claimed).
 * @returns whether a rebuild was queued.
 */
export const enqueueRebuildIfOverflowing = (
  ctx: Context,
  store: OpenStore,
  now: number,
): boolean => {
  // The global store's derived layer is the L3 portrait, and it is not
  // budget-driven: personal preferences do not overflow (twenty cost ~440
  // tokens against 1300), and the portrait's value is a disposition that
  // extrapolates, not compression. So the two store kinds ask different
  // questions — but through ONE job kind, so both inherit the same leasing,
  // fencing and busy-agent deferral (ADR 0004).
  if (store.kind === 'global') return enqueuePersonaRebuild(ctx, store, now)
  if (!packetOverflows(store)) return false
  return enqueueRebuild(ctx, store, now)
}

/**
 * Queue a portrait rebuild whenever the global store holds personal memories.
 *
 * There is no staleness test HERE: whether the portrait still describes the
 * person is a semantic judgement, so the job asks the model and answers
 * "keep" without writing (ADR 0004). Putting a proxy for that question in
 * code — a counter, an age, a threshold — would be the rejected trust formula
 * in a new costume: no count of edits correlates with someone changing.
 *
 * The revision still rides the idempotence key, so a portrait judgement is
 * queued at most once per snapshot: repeated maintenance passes over an
 * unchanged store collapse into the job that already ran.
 */
const enqueuePersonaRebuild = (ctx: Context, store: OpenStore, now: number): boolean => {
  const source = store.db
    .prepare(
      `SELECT count(*) AS n FROM memories
       WHERE status = 'active' AND derived = ${LAYER.RAW}`,
    )
    .get() as { n: number }
  if (source.n === 0) return false // nothing to portray
  return enqueueRebuild(ctx, store, now)
}

/** Shared enqueue: pins the current route and fences on the snapshot. */
const enqueueRebuild = (ctx: Context, store: OpenStore, now: number): boolean => {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection === undefined) return false // no route ⇒ no derived layer, and that is fine
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
  if (store.kind === 'global') return runPersonaJob(ctx, store, job, payload, signal)
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
    JSON.stringify({ memories: withinTranscriptBudget(sources) }),
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
       VALUES (?, 'fact', ?, 'active', ?, ?, '${DERIVED_PROVENANCE}', ?, ?, ${LAYER.SCENARIO})`,
    )
    const visibility = store.kind === 'global' ? 'private' : 'repo-local'
    for (const scenario of scenarios) {
      insert.run(randomUUID(), visibility, scenario.title, scenario.body, now, now)
    }
  })
  return true
}

/**
 * Take memories in packet order until the transcript budget is spent.
 *
 * The rollup is triggered by an overflow, so its input grows with the very
 * condition that triggers it — an unbounded prompt built from an unbounded
 * excess. Cutting here rather than asking the model to cope keeps the request
 * inside what any route can answer, and the order is the packet's own
 * (provenance, then recency), so what survives is what would have been
 * injected first. At least one memory always goes through: a rollup of
 * nothing is not a smaller rollup, it is a failed one.
 */
const withinTranscriptBudget = (rows: readonly MemoryHit[]): MemoryHit[] => {
  const out: MemoryHit[] = []
  let spent = 0
  for (const row of rows) {
    spent += row.title.length + row.body.length
    if (spent > ROLLUP_TRANSCRIPT_CHARS && out.length > 0) break
    out.push(row)
  }
  return out
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
 *
 * Truncation is to the ROLLUP TARGETS, not to the hard `*_MAX_CHARS` caps this
 * used to cut at. The targets were only ever a REQUEST inside the prompt, and
 * a request is not a bound: measured on a live store, all six blocks the model
 * returned exceeded `PERSONA_TARGET_CHARS`, five of six exceeded
 * `ROLLUP_TARGET_CHARS`, and bodies ran to 1820 characters against a target of
 * 900 — systematically about 2x. The hard caps (2000) then let all of it
 * through, so the derived layer blew the injection budget and half its blocks
 * were dropped unread.
 *
 * The load-time guard in `constants.ts` asserts that
 * `ROLLUP_MAX_SCENARIOS` blocks of this size fit the packet. An assertion is
 * only worth its arithmetic if the quantity it reasons about is the quantity
 * the write path actually guarantees — so the enforcement has to be HERE, at
 * the only door derived rows enter through. Asking the model more firmly was
 * the rejected alternative: it is the same request, and it already failed six
 * times out of six.
 *
 * ## The bound is in TOKENS, and the title's is not
 *
 * The body is cut with `truncatedToBudget` against `SCENARIO_MAX_TOKENS`, not
 * sliced to `ROLLUP_TARGET_CHARS`. The container that spends this row —
 * `renderFramed` against `INJECT_BODY_BUDGET_TOKENS` — prices RENDERED TOKENS,
 * and `renderEntry` indents every `\n` by two characters, so a character limit
 * cannot see part of what the row costs. Bounding the write in one unit while
 * the consumer bills in another is how a fully compliant row became
 * unaffordable: `withinBudget` SKIPS what it cannot pay for, so the row was not
 * shortened, it vanished (see `PERSONA_MAX_TOKENS`).
 *
 * `ROLLUP_TARGET_CHARS` keeps its job on the OTHER side of the exchange:
 * `prompts.ts` still asks the model for a character count, because a model
 * cannot count our tokens. The load-time satisfiability guard ties the two
 * together — the requested length must price under the ceiling at the worst
 * density we bill for — so what we ask for and what we enforce cannot drift
 * apart even though they are stated in different units.
 *
 * The TITLE is still cut by characters, and that is not an oversight. It has no
 * budget of its own; it is priced as part of the rendered row, whose bound is
 * the body's. A title carries no newlines in practice, and cutting it in tokens
 * would need a second budget nothing spends.
 *
 * Cutting rather than rejecting the block: a briefing whose last sentence is
 * clipped still restores a working context, while throwing away the whole
 * rollup because the model was verbose costs the layer entirely — and the
 * retry would re-ask the same model the same way.
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
    const title = scenario.title.trim().slice(0, ROLLUP_TITLE_TARGET_CHARS)
    // Cut against the rendered cost of the WHOLE entry, title included, which
    // is what the packet will actually be charged.
    const bounded = truncatedToBudget(
      { id: '', kind: 'fact', title, body: scenario.body.trim() },
      SCENARIO_MAX_TOKENS,
    )
    // `undefined` means the ceiling could not hold even a truncated body. It
    // cannot happen at the shipped constants (the load-time guards prove a
    // full-length block fits), but it is dropped rather than coerced: storing
    // an empty or `undefined` body would inject a bullet that says nothing
    // while still costing the budget a line.
    if (bounded === undefined) continue
    const body = bounded.body
    if (title === '' || body === '') continue
    out.push({ title, body })
  }
  if (out.length === 0) throw new PipelineLlmError('rollup produced no usable scenario')
  return out
}

/**
 * Run the portrait judgement for the global store (L3).
 *
 * Unlike the repo path this is not driven by budget: it asks whether the
 * stored portrait still describes the person, and writes ONLY on "rewrite".
 * A "keep" verdict commits the job without touching `memories`, which is what
 * keeps L3 from wobbling — and what makes D9 deleting the portrait harmless,
 * since the next pass restores the same text (ADR 0004).
 */
const runPersonaJob = async (
  ctx: Context,
  store: OpenStore,
  job: ClaimedJob,
  payload: RebuildPayload,
  signal: AbortSignal,
): Promise<boolean> => {
  const memories = store.db
    .prepare(
      `SELECT kind, title, body FROM memories
       WHERE status = 'active' AND derived = ${LAYER.RAW}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(PERSONA_SOURCE_LIMIT) as unknown as { kind: string; title: string; body: string }[]
  if (memories.length === 0) {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return false
  }
  const current = store.db
    .prepare(
      `SELECT body FROM memories WHERE derived = ${LAYER.PERSONA} AND status = 'active' LIMIT 1`,
    )
    .get() as { body: string } | undefined

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(
    ctx,
    route,
    personaSystemPrompt(),
    JSON.stringify({ portrait: current?.body ?? null, memories }),
    signal,
  )
  const verdict = parsePersona(parseStrictJson(reply))
  if (verdict.keep && current !== undefined) {
    // Judged still accurate: settle the job, write nothing. Not writing IS
    // the feature — an unconditional rewrite would churn the portrait, and
    // every write would advance the revision and invalidate the layer again.
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return false
  }

  commitClaimedJob(store, job.id, job.leaseToken, () => {
    if (readRevision(store) !== payload.expectedRevision) return
    const now = Date.now()
    // Exactly one portrait: replace rather than accumulate.
    store.db.prepare(`DELETE FROM memories WHERE derived = ${LAYER.PERSONA}`).run()
    store.db
      .prepare(
        `INSERT INTO memories
           (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
         VALUES (?, 'preference', 'private', 'active', ?, ?, '${DERIVED_PROVENANCE}', ?, ?, ${LAYER.PERSONA})`,
      )
      .run(randomUUID(), PERSONA_TITLE, verdict.body, now, now)
  })
  return true
}

/**
 * Validate a portrait reply. A "keep" needs no body; a "rewrite" without one
 * is malformed and reaches the retry exit rather than storing an empty
 * portrait that would inject as nothing.
 *
 * The body is cut to `PERSONA_MAX_TOKENS` for the reason given on
 * `parseScenarios`: the target was a request the model ignored (all six blocks
 * measured on a live store overshot it), and the portrait is spent from the
 * SAME injection budget in every repository — an oversized one does not merely
 * overrun, it evicts the scenario blocks queued behind it.
 *
 * Cut in TOKENS and with the same function as the scenario path, because this
 * is one rule with two execution points and the portrait is where the unit
 * mismatch actually bit: `worstPersonaTokens()` is the cap `recall/inject.ts`
 * applies to the personal side at runtime, and a portrait at exactly
 * `PERSONA_TARGET_CHARS` carrying 21 line breaks priced 172 against it. The
 * write path passed it, the read path skipped it whole, and the user got no
 * portrait at all. Fixing only one of the two points would leave the other
 * writing rows in a unit its container does not spend.
 */
const parsePersona = (raw: unknown): { keep: boolean; body: string } => {
  const root = raw as { verdict?: unknown; body?: unknown }
  if (root === null || typeof root !== 'object') {
    throw new PipelineLlmError('portrait reply is not an object')
  }
  if (root.verdict !== 'keep' && root.verdict !== 'rewrite') {
    throw new PipelineLlmError('portrait reply has no usable verdict')
  }
  if (root.verdict === 'keep') return { keep: true, body: '' }
  const bounded =
    typeof root.body === 'string'
      ? truncatedToBudget(
          { id: '', kind: 'preference', title: PERSONA_TITLE, body: root.body.trim() },
          PERSONA_MAX_TOKENS,
        )
      : undefined
  // A portrait that could not be cut to fit reaches the same exit as a missing
  // one: the retry path. Unlike a scenario block there is no sibling row to
  // fall back on — storing '' here would replace the portrait with a bullet
  // that says nothing, in every repository at once.
  const body = bounded?.body ?? ''
  if (body === '') throw new PipelineLlmError('portrait rewrite carries no body')
  return { keep: false, body }
}
