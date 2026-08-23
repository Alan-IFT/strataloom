/**
 * L0 conversation substrate: the turn transcript captured into OUR store.
 *
 * Why it exists: provenance and audit must not depend on the platform session
 * log still being there. `evidence.ref` names a session; L0 is what that name
 * resolves to. Capture happens at the turn boundary, in the SAME transaction
 * as the extract enqueue — so a queued job can always read the exact bytes it
 * was queued for, and a memory can always show the words behind it.
 *
 * What it is NOT: a second search index. `memory_recall` searches the
 * distilled layer; L0 is reached by (session, turn) or through a memory's
 * evidence. Adding FTS over raw conversations would mean two ranked corpora
 * competing to answer the same question — the retrieval ambiguity the
 * distilled layer exists to remove.
 * @module @strataloom/dsh-memory/store/conversations
 */
import type { OpenStore } from './store.ts'
import type { TranscriptEvent } from '../transcript.ts'
import { L0_RETENTION_MS } from '../constants.ts'

/**
 * Append one turn's classified events. Idempotent by (session, seq), so a
 * replayed or duplicated capture is absorbed rather than doubling the log.
 * MUST run inside a caller-owned transaction (D4/D6: capture and the extract
 * enqueue commit together or not at all).
 */
export const captureTurn = (
  store: OpenStore,
  sessionId: string,
  turn: number,
  events: readonly TranscriptEvent[],
): void => {
  const stmt = store.db.prepare(
    `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, seq) DO NOTHING`,
  )
  const now = Date.now()
  for (const event of events) {
    stmt.run(sessionId, event.seq, turn, event.label, event.provenance, event.text, now)
  }
}

/**
 * Read one turn back, in seq order. This is the extract job's input — it
 * reads our own durable copy, never the platform log, so extraction is
 * reproducible and needs no `sessionQuery` dependency.
 */
export const readTurn = (
  store: OpenStore,
  sessionId: string,
  turn: number,
): TranscriptEvent[] =>
  store.db
    .prepare(
      `SELECT seq, label, provenance, text FROM conversations
       WHERE session_id = ? AND turn = ? ORDER BY seq`,
    )
    .all(sessionId, turn) as unknown as TranscriptEvent[]

/**
 * Read the stored conversation behind a memory's session ref — the "show me
 * the original words" path (spec: L0 answers 核对原话/时间/来源).
 */
export const readSessionTurns = (
  store: OpenStore,
  sessionId: string,
  limit: number,
): TranscriptEvent[] =>
  store.db
    .prepare(
      `SELECT seq, label, provenance, text FROM conversations
       WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as TranscriptEvent[]

/**
 * Drop L0 rows older than the retention window, EXCEPT those a surviving
 * memory still cites: raw conversation is bulky and its job (feeding
 * extraction, proving provenance) is finite, but a memory must never outlive
 * the words that justify it.
 */
export const pruneConversations = (store: OpenStore, now: number): void => {
  store.tx(() => {
    store.db
      .prepare(
        `DELETE FROM conversations
         WHERE created_at < ?
           AND session_id NOT IN (
             SELECT e.ref FROM evidence e
             JOIN memories m ON m.id = e.memory_id
             WHERE e.kind = 'session' AND m.status != 'tombstone'
           )`,
      )
      .run(now - L0_RETENTION_MS)
  })
}
