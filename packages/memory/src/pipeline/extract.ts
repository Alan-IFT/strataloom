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


const renderTranscript = (events: readonly TranscriptEvent[]): string => {
  const lines: string[] = []
  let budget = EXTRACT_TRANSCRIPT_CHARS
  for (const event of events) {
    const excerpt =
      event.text.length > EXTRACT_EVENT_EXCERPT_CHARS
        ? `${event.text.slice(0, EXTRACT_EVENT_EXCERPT_CHARS)}…`
        : event.text
    const line = `[seq ${event.seq}] ${event.label}: ${excerpt}`
    if (line.length > budget) break
    lines.push(line)
    budget -= line.length
  }
  return lines.join('\n')
}

interface RawCandidate {
  title: string
  body: string
  kind: MemoryKind
  sourceSeqs: number[]
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
  if (transcript === '') {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return
  }

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(ctx, route, extractSystemPrompt(), transcript, signal)
  const candidates = parseCandidates(parseStrictJson(reply))

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
