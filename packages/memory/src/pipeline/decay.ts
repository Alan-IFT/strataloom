/**
 * Decay (spec §12): the daily batch that keeps recall's signal-to-noise from
 * degrading as a store grows.
 *
 * Three rules, one transaction, no LLM:
 *   1. an active memory nobody has retrieved for a long time goes `dormant`;
 *   2. a dormant memory retrieved recently comes BACK to active — revival
 *      happens HERE, never on the read path, because a read must not cause
 *      an authoritative change (D4);
 *   3. evidence excerpts older than the compaction window are dropped —
 *      their audit value has expired but the ref (source suppression) stays.
 *
 * `dormant` is not deletion: the row keeps its content and can revive. It
 * only leaves the read surfaces, which is exactly what "noise" means.
 * @module @strataloom/dsh-memory/pipeline/decay
 */
import type { OpenStore } from '../store/store.ts'
import { commitClaimedJob, type ClaimedJob } from './jobs.ts'
import {
  DECAY_IDLE_MS,
  DECAY_REVIVE_MS,
  EXCERPT_COMPACT_MS,
  DECAY_MIN_ACTIVE,
} from '../constants.ts'

/**
 * Run one claimed decay job. Pure SQL inside the job's single commit, so it
 * inherits the fencing guarantee without adding machinery (D6).
 */
export const runDecayJob = (store: OpenStore, job: ClaimedJob, now: number) => {
  const report: { slept: number; revived: number; excerptsCompacted: number } = {
    slept: 0,
    revived: 0,
    excerptsCompacted: 0,
  }
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

    // Excerpt compaction: the quote ages out, the ref never does.
    const compacted = store.db
      .prepare(
        `UPDATE evidence SET excerpt = NULL
         WHERE excerpt IS NOT NULL AND memory_id IN (
           SELECT id FROM memories WHERE updated_at < ?
         )`,
      )
      .run(now - EXCERPT_COMPACT_MS)
    report.excerptsCompacted = Number(compacted.changes)
  })
  return report
}
