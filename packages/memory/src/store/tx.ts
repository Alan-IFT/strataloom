/**
 * The one write-transaction primitive: `BEGIN IMMEDIATE` with bounded busy
 * retry (spec §3.3 — "凡可能写，一律 BEGIN IMMEDIATE"). Deferred BEGIN would
 * hit SQLITE_BUSY_SNAPSHOT on read-then-write upgrades, which busy_timeout
 * does NOT cover; IMMEDIATE moves contention to the transaction head where
 * busy_timeout + this retry loop apply (verified in `.verify-v26` T3/T3b).
 * @module @strataloom/dsh-memory/store/tx
 */
import type { DatabaseSync } from 'node:sqlite'
import { BUSY_BACKOFF_MS, IMMEDIATE_TX_RETRIES } from '../constants.ts'

/**
 * "Did this throw come from losing a lock race?" — exported because the
 * scheduler needs the SAME answer this file acts on. A busy failure is the one
 * failure that proves something about the NEXT write: the lock is held by
 * another process, so a further write transaction would only re-lose the same
 * race (`runner.ts` uses that to skip a doomed claim). Any second spelling of
 * this predicate would be a second source of truth that drifts from the retry
 * loop it is supposed to agree with.
 */
export const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: number } | null)?.errcode
  // SQLITE_BUSY (5) and extended codes (261 BUSY_RECOVERY, 517 BUSY_SNAPSHOT…).
  return typeof code === 'number' && (code & 0xff) === 5
}

/**
 * Sleep without yielding the event loop. `Atomics.wait` is the only way to
 * pause a synchronous function, and this whole layer is synchronous because
 * `DatabaseSync` is: the prompt-assembly path cannot await.
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Retry a statement that can lose a lock race, with jittered backoff.
 *
 * `busy_timeout` covers most contention, but not every case: switching a
 * fresh database into WAL takes a brief exclusive lock that the timeout does
 * not wait for, so two processes creating the same store at once can collide.
 * Jitter matters — writers backing off in lockstep keep colliding.
 * @param attempt - retry helper for one lock-sensitive statement.
 */
export const withBusyRetry = <T>(run: () => T): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      return run()
    } catch (error) {
      if (!isBusy(error) || attempt >= IMMEDIATE_TX_RETRIES) throw error
      sleepSync(BUSY_BACKOFF_MS * (attempt + 1) * (1 + Math.random()))
    }
  }
}

/**
 * Run `body` inside one immediate transaction. Returns the body's value.
 * On SQLITE_BUSY at BEGIN, retries with backoff. Any body throw rolls the
 * whole transaction back and rethrows — no partial commits, fail loud.
 */
export const immediateTx = <T>(db: DatabaseSync, body: () => T): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (!isBusy(error) || attempt >= IMMEDIATE_TX_RETRIES) throw error
      // `busy_timeout` already waited its full budget inside the failed
      // attempt, so retrying instantly would just re-enter the same losing
      // race and burn every attempt in microseconds. Back off — with jitter,
      // because several writers that back off in lockstep keep colliding.
      sleepSync(BUSY_BACKOFF_MS * (attempt + 1) * (1 + Math.random()))
      continue
    }
    try {
      const value = body()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Connection-level failure: the original error is the story.
      }
      throw error
    }
  }
}
