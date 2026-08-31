/**
 * Extract job (spec §5.1/§2.4): read the turn transcript, ask the pipeline
 * model for candidates + source event seqs, then map seqs to provenance by
 * event CATEGORY in code (the model never assigns provenance — D1). Mixed
 * sources take minimum trust; unknown categories are tool-output (fail
 * closed). Candidates land as status='candidate' with a session evidence
 * row; the batch reconcile job is enqueued in the SAME commit (D6).
 * @module @strataloom/dsh-memory/pipeline/extract
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

import type { OpenStore } from '../store/store.ts'
import type { MemoryKind } from '../types.ts'
import { provenanceFor, type TranscriptEvent } from '../transcript.ts'
import { readTurn } from '../store/conversations.ts'
import { MEMORY_KINDS } from '../types.ts'
import {
  EXTRACT_EVENT_EXCERPT_CHARS,
  EXTRACT_MAX_CANDIDATES,
  EXTRACT_TRANSCRIPT_CHARS,
  TITLE_MAX_CHARS,
  BODY_MAX_CHARS,
  WORST_SOURCE_SEQS,
} from '../constants.ts'
import { callPipelineLlm, parseStrictJson, PipelineLlmError, type PinnedRoute } from './llm-call.ts'
import { extractSystemPrompt, PAYLOAD_VERSION, PROMPT_VERSION } from './prompts.ts'
import { commitClaimedJob, enqueueJob, jobId, type ClaimedJob } from './jobs.ts'

/** Extract job payload (pinned at enqueue time — spec §5.1). */
export interface ExtractPayload {
  readonly sessionId: string
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly promptVersion: number
  readonly payloadVersion: number
}


/**
 * Cut one event's text to the per-event cap, marking the cut.
 *
 * ONE function because `EXTRACT_EVENT_EXCERPT_CHARS` is one rule with two
 * execution points — the transcript the model reads and the excerpt the
 * evidence row stores — and a rule enforced in two places must be one rule.
 * Written out twice, the two copies drift in exactly the way that is invisible
 * from either side: the same constant would produce a trailing `…` in the
 * prompt and a hard cut in the audit trail, so a reviewer comparing an excerpt
 * against the transcript could not tell a truncation from a verbatim quote.
 *
 * The ellipsis is part of the rule, not decoration: it is the only signal in
 * the stored bytes that says "there was more". Its cost is +1 over the cap and
 * that is deliberate — `EXTRACT_EVENT_EXCERPT_CHARS` bounds the TEXT kept, and
 * the mark is what tells a reader the text was bounded at all.
 *
 * NOT for `transcript.ts`'s `summarizeArguments`, which spends the same
 * constant with a DIFFERENT degradation: it replaces an over-long argument
 * value wholesale with `<N chars>` rather than keeping a truncated head. That
 * asymmetry is the design (`constants.ts` states it): a quote is worth reading
 * in part, an argument value is not. Two execution points share this function;
 * the third shares only the number, and folding it in here would trade a
 * documented difference for a false uniformity.
 */
const capEventText = (text: string): string =>
  text.length > EXTRACT_EVENT_EXCERPT_CHARS
    ? `${text.slice(0, EXTRACT_EVENT_EXCERPT_CHARS)}…`
    : text

/** One transcript event as the model receives it (spec §5.1 input shape). */
interface PromptEvent {
  readonly seq: number
  readonly label: string
  readonly text: string
}

/** The whole extract input: one JSON object, `JSON.stringify`d at the call site. */
interface PromptTranscript {
  readonly events: readonly PromptEvent[]
}

/**
 * Build the extract input as DATA rather than as prose.
 *
 * The earlier shape joined `[seq N] <label>: <excerpt>` lines with newlines,
 * which made the transcript a format an event could write in: any text
 * carrying a newline produced bytes indistinguishable from a real record, and
 * the prompt tells the model those seq numbers select trust downstream. So a
 * tool result — the lowest trust there is — could mint a line the model would
 * attribute to the human, and `provenanceFor` would return `human`, the only
 * level that reaches the default injection packet.
 *
 * JSON removes the capability instead of filtering for it: inside a string
 * value, a newline, a quote, or a whole `"}],"events":[{` is escaped, so
 * "looks like another record" is not something an event's bytes can express.
 * This is also what the other three pipeline call sites already do
 * (`reconcile`, `rollup`, `persona` all `JSON.stringify` their input) — the
 * hand-joined text here was the one exception, not the convention.
 *
 * Each event costs what it actually adds to the payload, and it is spent whole
 * or not at all: a half record is exactly the artifact this shape exists to
 * make impossible.
 *
 * An event that does not fit is SKIPPED, and the cheaper ones behind it are
 * still considered. This used to `break` — end the transcript at the first
 * event too large for the remaining budget — which made ONE oversized row a
 * wall: past it, everything the turn contained was invisible whatever it cost.
 * `recall/render.ts: withinBudget` had already settled the question the other
 * way, in a comment that states the rule outright ("An entry that does not fit
 * is SKIPPED, not treated as end-of-list"), and this was the last budget point
 * in the codebase still disagreeing with it. Measured over 46 real sessions,
 * skipping keeps 4% more events; the real argument is that a rule enforced in
 * two places must be ONE rule, and "one oversized item must not hide the
 * cheaper ones queued behind it" is not a property of packets, it is a
 * property of budgets.
 *
 * `withinBudget` itself is deliberately NOT called here, and that is not an
 * omission to be tidied up later. It prices entries through `renderEntry`
 * against a TOKEN budget, because its container is the injection packet; this
 * prices JSON records against a CHARACTER budget, because its container is the
 * prompt payload. Two containers, two rulers, one rule — the same distinction
 * `constants.ts` draws between the load-time derived guard and the runtime
 * personal cap. Sharing the function would force one container to be measured
 * with the other's ruler, which is how a budget stops meaning anything.
 *
 * "What it adds" is charged literally, so `EXTRACT_TRANSCRIPT_CHARS` bounds
 * the string the model receives, not the sum of its parts. The wrapper
 * (`{"events":[]}`) is paid up front and every event after the first pays for
 * its separating comma; charging entries alone would let 12 + n characters
 * past the cap — bounded and small, but it would make the constant's name a
 * claim the code does not keep, and the budget numbers in this file are read
 * as a specification.
 *
 * A label is also no longer exempt; it used to ride outside the accounting as
 * a line prefix. Per-event overhead is therefore higher, and the cost is worth
 * measuring rather than leaving to be discovered. Against this repo's own L0,
 * whose events run to a median of 165 characters:
 *
 *   400-char events  -7%      100-char events  -15%
 *   200-char events  -11%      20-char events  -37%
 *
 * Replaying every real turn in that store keeps 327 events where the old
 * format kept 364 — 10% fewer, against truncation that was already dropping
 * 66% of them, so the net change is three points and what it drops is the
 * tail of long tool output rather than the reasoning. That is the price of a
 * transcript whose records cannot be forged: it is paid in volume, not in
 * meaning.
 */
const renderTranscript = (events: readonly TranscriptEvent[]): PromptTranscript => {
  const kept: PromptEvent[] = []
  let budget = EXTRACT_TRANSCRIPT_CHARS - JSON.stringify({ events: [] }).length
  for (const event of events) {
    const entry: PromptEvent = {
      seq: event.seq,
      label: event.label,
      text: capEventText(event.text),
    }
    // The comma joining this entry to the previous one is part of what it
    // adds, so it is part of what it costs.
    const cost = JSON.stringify(entry).length + (kept.length === 0 ? 0 : 1)
    if (cost > budget) continue
    kept.push(entry)
    budget -= cost
  }
  return { events: kept }
}

interface RawCandidate {
  title: string
  body: string
  kind: MemoryKind
  sourceSeqs: number[]
}

/**
 * Parse an extract reply, treating "nothing to remember" as an ANSWER rather
 * than a malformed one.
 *
 * The prompt asks for `{"candidates":[]}` when a turn holds nothing durable,
 * and most turns hold nothing durable — so a model that answers in prose
 * instead ("no reusable lessons here") is being cooperative, not broken.
 * Sending that through the strict-JSON path made it a retry, and retrying a
 * semantic judgement re-asks the same question of the same text: it cannot
 * succeed. Measured on a live store — one turn of shell and file-read output
 * burned all six attempts and dead-lettered with "model reply is not valid
 * JSON", while the turns either side of it, on the same route and model,
 * finished on attempt 1.
 *
 * Only THIS prompt gets the empty reading, and only when no object is present
 * at all. A reply that does contain an object still goes through the strict
 * parser, so a genuinely malformed one still fails loudly — `rollup` and
 * `persona` keep the strict path entirely, because for them an unparseable
 * reply means the work did not happen.
 */
const parseExtractReply = (reply: string): unknown => {
  const text = reply.trim()
  if (text === '' || !text.includes('{')) return { candidates: [] }
  return parseStrictJson(text)
}

const parseCandidates = (raw: unknown): RawCandidate[] => {
  const root = raw as { candidates?: unknown }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.candidates)) {
    throw new PipelineLlmError('reply missing candidates array')
  }
  const out: RawCandidate[] = []
  for (const item of root.candidates.slice(0, EXTRACT_MAX_CANDIDATES)) {
    const candidate = item as Partial<RawCandidate>
    if (
      typeof candidate.title !== 'string' ||
      typeof candidate.body !== 'string' ||
      typeof candidate.kind !== 'string' ||
      !MEMORY_KINDS.includes(candidate.kind as MemoryKind) ||
      !Array.isArray(candidate.sourceSeqs)
    ) {
      throw new PipelineLlmError('malformed candidate in reply')
    }
    const title = candidate.title.trim().slice(0, TITLE_MAX_CHARS)
    const body = candidate.body.trim().slice(0, BODY_MAX_CHARS)
    if (title === '' || body === '') continue
    out.push({
      title,
      body,
      kind: candidate.kind as MemoryKind,
      // Bounded like every other field of a reply — this was the one that was
      // not. `candidates`, `title` and `body` are all cut to a constant above;
      // `sourceSeqs` was filtered for type and then trusted for length, and
      // two things downstream depended on a bound nobody enforced.
      //
      // `WORST_SOURCE_SEQS` is that bound, IMPORTED rather than re-typed:
      // `constants.ts` builds the worst permitted reply from it and asserts
      // `EXTRACT_TRANSCRIPT_CHARS + worstExtractReplyChars() <= LLM_MAX_TOKENS`.
      // At 10 that solves to 5300 + 6682 = 11982 against a 12000 cap — 18
      // characters of margin — and at 11 to 12017, over it. The guard already
      // priced the reply as if this cap existed; until now the parse did not
      // apply it, so the guard was certifying a shape the code permitted the
      // model to exceed. Whether an over-long reply actually costs anything
      // depends on the provider: `maxTokens` may count the completion alone or
      // the whole exchange, and which of the two a route means is not visible
      // from here (see the note above `worstExchangeChars`). ON A PROVIDER
      // THAT PRICES THE WHOLE EXCHANGE, the reply comes back truncated,
      // `llm-call.ts` reads the non-`stop` finish as a failure, the job
      // retries and eventually dead-letters. That is a conditional failure
      // mode, not a certain one — the bound exists because the guard is
      // otherwise asserting something no code keeps.
      //
      // ORDER IS LOAD-BEARING: filter, then DEDUPE, then slice. Truncating
      // before de-duplicating would let ten repetitions of one seq evict ten
      // distinct sources, so the reply that cites its evidence worst would
      // keep the most of it. De-duplication is also what bounds the EXCERPT
      // below, which repeats each cited event's text: measured by reverting
      // this line, 200 copies of one legal seq pointing at a 5000-character
      // row render an 82595-character excerpt out of a 400-character rule, and
      // the old join-then-truncate hid that by cutting the result rather than
      // by never building it.
      //
      // Dropping duplicates cannot change provenance: `provenanceFor` maps
      // then reduces to the minimum `PROVENANCE_PRIORITY`, and min is
      // idempotent — a repeated seq contributes nothing a single one does not.
      // The empty case is answered before the reduce, and de-duplication never
      // turns a non-empty list empty.
      sourceSeqs: [
        ...new Set(candidate.sourceSeqs.filter((seq): seq is number => typeof seq === 'number')),
      ].slice(0, WORST_SOURCE_SEQS),
    })
  }
  return out
}

/** Reconcile payload: the batch is the extract's inserted candidate ids. */
export interface ReconcilePayload {
  readonly sessionId: string
  readonly turn: number
  readonly candidateIds: readonly string[]
  readonly provider: string
  readonly model: string
  readonly promptVersion: number
  readonly payloadVersion: number
}

/**
 * Run one claimed extract job to its single commit. Throws to reach the
 * runner's retry exit; commits exactly once on success (fencing first).
 */
export const runExtractJob = async (
  ctx: Context,
  store: OpenStore,
  job: ClaimedJob,
  payload: ExtractPayload,
  signal: AbortSignal,
): Promise<void> => {
  // Read our OWN L0 copy, captured in the same transaction that queued this
  // job (spec: L0 substrate). No `sessionQuery`, no dependency on the
  // platform log still existing — extraction is reproducible from our store.
  const turnEvents = readTurn(store, payload.sessionId, payload.turn)
  const transcript = renderTranscript(turnEvents)
  // Nothing survived the budget (or the turn held nothing) — there is no
  // question to ask, so settle without burning a call.
  if (transcript.events.length === 0) {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return
  }

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(
    ctx,
    route,
    extractSystemPrompt(),
    JSON.stringify(transcript),
    signal,
  )
  const candidates = parseCandidates(parseExtractReply(reply))

  const bySeq = new Map(turnEvents.map((event) => [event.seq, event]))
  const now = Date.now()
  const sessionRef = payload.sessionId

  commitClaimedJob(store, job.id, job.leaseToken, () => {
    // Source suppression (spec §6): a tombstoned memory citing this session
    // ref blocks auto-relearning from the same source.
    const suppressed = store.db
      .prepare(
        `SELECT 1 FROM evidence e JOIN memories m ON m.id = e.memory_id
         WHERE e.kind = 'session' AND e.ref = ? AND m.status = 'tombstone' LIMIT 1`,
      )
      .get(sessionRef)
    if (suppressed !== undefined || candidates.length === 0) return

    const insertMemory = store.db.prepare(
      `INSERT INTO memories
         (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES (?, ?, 'repo-local', 'candidate', ?, ?, ?, ?, ?)`,
    )
    const insertEvidence = store.db.prepare(
      `INSERT INTO evidence (memory_id, kind, ref, excerpt) VALUES (?, 'session', ?, ?)`,
    )
    const candidateIds: string[] = []
    for (const candidate of candidates) {
      const id = randomUUID()
      const provenance = provenanceFor(candidate.sourceSeqs, bySeq)
      insertMemory.run(id, candidate.kind, candidate.title, candidate.body, provenance, now, now)
      // The excerpt is the actual cited source text (audit value, D3) — a
      // list of seq numbers would prove nothing to a human reviewing it.
      //
      // The cap is applied PER SEGMENT, which is what the constant has always
      // said it is ("Per-event excerpt cap") and what `capEventText` does for
      // the transcript one screen up. It used to be applied to the JOINED
      // string, so a candidate citing four events got 400 characters to share
      // between them: measured on this repo's own stores, 218 of 241 excerpts
      // were exactly 400 characters long, with no natural tail below it — the
      // second citation onwards was routinely cut mid-word or lost outright,
      // while the row still read as a complete quotation. An auditor
      // reconstructing which sources a memory came from got the wrong answer
      // from it, which is the one thing this column exists to answer.
      //
      // Per-segment truncation is safe only because `sourceSeqs` is bounded
      // above: the excerpt is now at most WORST_SOURCE_SEQS segments and the
      // whole-string cut is no longer what stands between this and an
      // unbounded write. That is the same bound, doing its second job.
      //
      // Only the TEXT is cut; `[label]` is always emitted whole. Cutting the
      // prefix would produce `[tool:ba` — a segment whose source cannot be
      // read at all — and a truncation that destroys the attribution is worse
      // than one that shortens the quote.
      //
      // KNOWN LIMIT, stated rather than papered over: `\n---\n` is a
      // separator an event's own text can WRITE.
      //
      // Measured across this machine's seven stores at 2026-08-31T13:37Z
      // (absolutes are timestamped because L0 grows: this same scan read 4702
      // rows earlier in the session and 4763 an hour later). Denominators are
      // named because two different ratios are easy to confuse here:
      //   - 116 of 4763 L0 rows (2.44%) — denominator: ALL `conversations`
      //     rows — carry the literal sequence in their own text.
      //   - 20 of 241 stored excerpts (8.30%) — denominator: NON-EMPTY
      //     excerpts — already split into at least one segment with no
      //     `[label] ` opener, i.e. cannot be decomposed back into sources.
      // A third figure, 142 of 241 (58.92%), counts excerpts merely CONTAINING
      // the separator; that is mostly this writer's own legitimate joins and
      // is NOT a defect rate. Only the second number measures ambiguity.
      //
      // The excerpt is audit material for a HUMAN reader, and for that a
      // separator that is occasionally ambiguous is acceptable; it is NOT a
      // machine-parseable format and no consumer should treat it as one.
      // A consumer that needs
      // reliable per-source segmentation should get structured storage (a row
      // per cited seq), not a cleverer delimiter — escaping or lengthening the
      // separator would only move the ambiguity, and it would break the
      // readability of every excerpt already written.
      const excerpt = candidate.sourceSeqs
        .map((seq) => bySeq.get(seq))
        .filter((cited) => cited !== undefined)
        .map((cited) => `[${cited.label}] ${capEventText(cited.text)}`)
        .join('\n---\n')
      insertEvidence.run(id, sessionRef, excerpt === '' ? null : excerpt)
      candidateIds.push(id)
    }
    const reconcile: ReconcilePayload = {
      sessionId: payload.sessionId,
      turn: payload.turn,
      candidateIds,
      provider: payload.provider,
      model: payload.model,
      promptVersion: PROMPT_VERSION,
      payloadVersion: PAYLOAD_VERSION,
    }
    enqueueJob(
      store,
      'reconcile',
      jobId('reconcile', store.repoKey, payload.sessionId, payload.turn),
      reconcile,
      now,
      true,
    )
  })
}
