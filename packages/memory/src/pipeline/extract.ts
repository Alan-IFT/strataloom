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
 * Budget semantics are carried over unchanged in kind: each event costs what
 * it actually adds to the payload, and an event that does not fit ENDS the
 * transcript rather than being trimmed. Whole records or none: a half record
 * is exactly the artifact this shape exists to make impossible.
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
    const text =
      event.text.length > EXTRACT_EVENT_EXCERPT_CHARS
        ? `${event.text.slice(0, EXTRACT_EVENT_EXCERPT_CHARS)}…`
        : event.text
    const entry: PromptEvent = { seq: event.seq, label: event.label, text }
    // The comma joining this entry to the previous one is part of what it
    // adds, so it is part of what it costs.
    const cost = JSON.stringify(entry).length + (kept.length === 0 ? 0 : 1)
    if (cost > budget) break
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
      sourceSeqs: candidate.sourceSeqs.filter((seq): seq is number => typeof seq === 'number'),
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
      const excerpt = candidate.sourceSeqs
        .map((seq) => bySeq.get(seq))
        .filter((cited) => cited !== undefined)
        .map((cited) => `[${cited.label}] ${cited.text}`)
        .join('\n---\n')
        .slice(0, EXTRACT_EVENT_EXCERPT_CHARS)
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
