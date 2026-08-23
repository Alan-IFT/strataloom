/**
 * Observability (spec §9). One periodic structured-log line per store.
 *
 * Every number here is COMPUTED FROM THE STORE, never accumulated in memory:
 * a counter would need maintaining at every write site, would drift across
 * processes, and would reset on restart. A snapshot query has none of those
 * problems and costs one statement per interval.
 *
 * The set is not arbitrary — these are exactly the trigger indicators §12
 * names for the deferred capabilities, so "should we enable X" is answered
 * with data rather than taste:
 *   packetTokens / injectableCount → derived summary layer (Packet overflow)
 *   activeCount / retrievedRate    → dormant/decay (recall signal-to-noise)
 *   overturnRate                   → continuous trust (real misjudgements)
 *   oldestPendingJobAgeMs / deadLettered → pipeline health
 * @module @strataloom/dsh-memory/metrics
 */
import type { OpenStore } from './store/store.ts'
import { INJECT_TOP_N } from './constants.ts'
import { queryInjectableSet } from './store/fts.ts'
import { packetTokens } from './recall/inject.ts'

const one = (store: OpenStore, sql: string, ...params: unknown[]): number => {
  const row = store.db.prepare(sql).get(...(params as never[])) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * Snapshot one store. Every field answers a decision someone actually makes
 * — corpus size drives decay, packet cost drives the derived layer, overturn
 * drives the trust question, and the job fields say whether work is stuck.
 * A number nobody acts on would be noise that still costs a query.
 */
export const collectMetrics = (store: OpenStore, now: number) => {
  const byStatus = (status: string): number =>
    one(store, `SELECT count(*) AS n FROM memories WHERE status = ?`, status)

  // The injectable set and its price come from the same helpers the packet
  // itself uses, so these numbers mean what §4.2's budget means.
  const injectable = queryInjectableSet(store, INJECT_TOP_N)

  const active = byStatus('active')
  const superseded = byStatus('superseded')
  const archived = byStatus('archived')
  const retrieved = one(
    store,
    `SELECT count(*) AS n FROM usage u JOIN memories m ON m.id = u.memory_id
     WHERE m.status = 'active' AND u.retrieved > 0`,
  )
  const oldestPending = store.db
    .prepare(`SELECT min(created_at) AS n FROM jobs WHERE state = 'pending'`)
    .get() as { n: number | null }

  return {
    store: store.repoKey,
    kind: store.kind,
    activeCount: active,
    packetTokens: packetTokens(injectable),
    retrievedRate: active === 0 ? 0 : Number((retrieved / active).toFixed(3)),
    overturnRate:
      active + superseded + archived === 0
        ? 0
        : Number(((superseded + archived) / (active + superseded + archived)).toFixed(3)),
    pendingJobs: one(store, `SELECT count(*) AS n FROM jobs WHERE state = 'pending'`),
    oldestPendingJobAgeMs: oldestPending.n === null ? 0 : now - oldestPending.n,
    deadLettered: one(store, `SELECT count(*) AS n FROM jobs WHERE state = 'failed'`),
  }
}
