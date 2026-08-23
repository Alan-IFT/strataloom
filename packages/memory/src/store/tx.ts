/**
 * The one write-transaction primitive: `BEGIN IMMEDIATE` with bounded busy
 * retry (spec §3.3 — "凡可能写，一律 BEGIN IMMEDIATE"). Deferred BEGIN would
 * hit SQLITE_BUSY_SNAPSHOT on read-then-write upgrades, which busy_timeout
 * does NOT cover; IMMEDIATE moves contention to the transaction head where
 * busy_timeout + this retry loop apply (verified in `.verify-v26` T3/T3b).
 * @module @strataloom/dsh-memory/store/tx
 */
import type { DatabaseSync } from 'node:sqlite'
import { IMMEDIATE_TX_RETRIES } from '../constants.ts'

const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: number } | null)?.errcode
  // SQLITE_BUSY (5) and extended codes (261 BUSY_RECOVERY, 517 BUSY_SNAPSHOT…).
  return typeof code === 'number' && (code & 0xff) === 5
}

/**
 * Run `body` inside one immediate transaction. Returns the body's value.
 * On SQLITE_BUSY at BEGIN, retries up to {@link IMMEDIATE_TX_RETRIES} times
 * (busy_timeout already waited inside each attempt). Any body throw rolls the
 * whole transaction back and rethrows — no partial commits, fail loud.
 */
export const immediateTx = <T>(db: DatabaseSync, body: () => T): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (isBusy(error) && attempt < IMMEDIATE_TX_RETRIES) continue
      throw error
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
