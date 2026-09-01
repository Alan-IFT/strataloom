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
 * Read the tail of a stored session — the FALLBACK half of the "show me the
 * original words" path (spec: L0 answers 核对原话/时间/来源).
 *
 * Not the primary half, and the distinction matters to anyone reading this as
 * the answer to "what did a memory come from". `service.source` calls this
 * only when the memory's evidence row carries no stored quotation; when one
 * exists, it returns `evidence.excerpt` — the passage actually cited — and
 * never reaches here.
 *
 * The reason is in the ORDER BY: this returns the LAST `limit` rows of the
 * session, and cited lines are distributed evenly through a session
 * (p25=0.24 / p50=0.57 / p75=0.80), so only 9.3% of them fall in this window.
 * What this function returns is late-session CONTEXT, which is genuinely
 * useful when nothing better was recorded and is honestly labelled as such by
 * the caller — but it is not the same fact as "the words this memory quotes",
 * and it must not be presented as one.
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
 *
 * READ THIS BEFORE CHANGING THE PREDICATE: this statement currently deletes
 * nothing, and has never deleted anything. Measured across the 9 real stores
 * on 2026-09-01, EACH clause independently spares all 6813 rows (4,964,787
 * CHARACTERS as SQLite `length()` counts them; 6,498,240 UTF-8 bytes, an
 * expansion of 1.31x on this CJK-heavy corpus — the two units are not
 * interchangeable and this comment previously said "bytes" for the character
 * figure): the exemption spares them because every session in those stores is
 * cited, and the age bound spares them because nothing is old enough yet (the
 * age condition first becomes satisfiable in late November 2026). The
 * observable effect of L0 retention is therefore that L0 IS RETAINED WITHOUT
 * BOUND. That is a registered trade-off, not a temporary state: `evidence.ref`
 * names a whole session, so one memory pins every turn beside the ones it
 * quotes, and there is no mechanism by which a cited session ever ages out.
 *
 * The age clause looks dead and is not. It is the ONLY protection keyed on how
 * old a row is, and it covers the unavoidable gap between `captureTurn` —
 * which writes at the turn boundary UNCONDITIONALLY, because recording what
 * was said must not depend on wanting to distil it — and the evidence an
 * extract job may write much later, or never: turns under
 * `ENQUEUE_MIN_TURN_TOKENS` are never enqueued, and an extract that finds
 * nothing worth keeping writes no evidence at all. Deleting the age clause
 * would not remove a no-op; it would delete every in-flight, sub-threshold and
 * empty-yield conversation — precisely the rows that have nothing but their
 * raw record, which is what L0 is for. Both halves are now pinned by tests in
 * `test/layers.test.mjs`; before those, the age half had no coverage and a
 * mutation forcing it true left the whole suite green.
 *
 * What those tests do NOT pin is the deletion VOLUME. They assert that rows
 * which must survive do survive; nothing asserts that this statement still
 * deletes nothing. So if `evidence.ref` ever moves to seq granularity — the
 * direction ADR 0012 keeps circling — L0 would start deleting silently and
 * every test here would stay green. Anyone making that change owns the job of
 * measuring what it removes BEFORE shipping it; the number to beat is the one
 * above, and `docs/audit-2026-09-01-l0-retention.md` records how it was taken.
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
