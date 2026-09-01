/**
 * Decay (spec §12): the daily batch that keeps recall's signal-to-noise from
 * degrading as a store grows.
 *
 * Two rules, one transaction, no LLM:
 *   1. an active memory nobody has retrieved for a long time goes `dormant`;
 *   2. a dormant memory retrieved recently comes BACK to active — revival
 *      happens HERE, never on the read path, because a read must not cause
 *      an authoritative change (D4).
 *
 * `dormant` is not deletion: the row keeps its content and can revive. It
 * only leaves the read surfaces, which is exactly what "noise" means.
 *
 * A THIRD rule used to live here: excerpts older than `EXCERPT_COMPACT_MS`
 * were nulled while their refs survived, and the job reported an
 * `excerptsCompacted` count. Both are gone. `service.source` now reads
 * `evidence.excerpt` as its primary evidence path, which changes that
 * statement from "drop an unread column" into "destroy the proof D3
 * promises" — and destroy it against words that, thanks to
 * `pruneConversations`'s exemption for cited sessions, never expire at all.
 * The deleted constant in `constants.ts` carries the full argument and the
 * measurements. The count went with the rule rather than staying as a
 * permanent zero: an observable that can only report 0 invites the reader to
 * conclude something was checked.
 *
 * Decay no longer touches `evidence` in any way. This job ages MEMORIES; how
 * long their evidence lives is defined once, by that exemption clause.
 * @module @strataloom/dsh-memory/pipeline/decay
 */
import type { OpenStore } from '../store/store.ts'
import { commitClaimedJob, type ClaimedJob } from './jobs.ts'
import { DECAY_IDLE_MS, DECAY_REVIVE_MS, DECAY_MIN_ACTIVE } from '../constants.ts'

/**
 * Run one claimed decay job. Pure SQL inside the job's single commit, so it
 * inherits the fencing guarantee without adding machinery (D6).
 */
export const runDecayJob = (store: OpenStore, job: ClaimedJob, now: number) => {
  const report: { slept: number; revived: number } = { slept: 0, revived: 0 }
  commitClaimedJob(store, job.id, job.leaseToken, () => {
    // Below the floor, aging out entries would cost recall more than the
    // noise it removes: a small store has no noise problem to solve.
    const active = store.db
      .prepare(`SELECT count(*) AS n FROM memories WHERE status = 'active' AND derived = 0`)
      .get() as { n: number }
    if (active.n > DECAY_MIN_ACTIVE) {
      const slept = store.db
        .prepare(
          `UPDATE memories SET status = 'dormant', updated_at = ?
           WHERE status = 'active' AND derived = 0 AND updated_at < ?
             AND id NOT IN (
               SELECT memory_id FROM usage WHERE last_hit_at IS NOT NULL AND last_hit_at >= ?
             )`,
        )
        .run(now, now - DECAY_IDLE_MS, now - DECAY_IDLE_MS)
      report.slept = Number(slept.changes)
    }

    // Revival: recently useful again ⇒ back on the read surfaces.
    const revived = store.db
      .prepare(
        `UPDATE memories SET status = 'active', updated_at = ?
         WHERE status = 'dormant'
           AND id IN (
             SELECT memory_id FROM usage WHERE last_hit_at IS NOT NULL AND last_hit_at >= ?
           )`,
      )
      .run(now, now - DECAY_REVIVE_MS)
    report.revived = Number(revived.changes)
  })
  return report
}
