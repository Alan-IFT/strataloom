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
 *   recallMissRate                 → retrieval fusion (see the caveat below)
 *   oldestPendingJobAgeMs / deadLettered → pipeline health
 * @module @strataloom/dsh-memory/metrics
 */
import type { OpenStore } from './store/store.ts'
import { INJECT_TOP_N } from './constants.ts'
import { queryInjectableSet } from './store/fts.ts'
import { RECALL_NO_MATCH } from './tools.ts'
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
 *
 * **`recallMissRate` is a screening signal, not a verdict.** It prices the
 * deferred retrieval-fusion work, and it is honest about what it cannot
 * separate. A miss is any of:
 *
 *   A. the store genuinely lacks that knowledge — embeddings cannot help;
 *   B. the wording missed a memory that IS there — embeddings could help;
 *   C. a speculative probe nobody expected to hit — nothing to fix.
 *
 * Only (B) argues for an embedding dependency, and no counter can tell the
 * three apart, because separating them requires knowing what SHOULD have
 * matched — that is labelled data, not arithmetic. So a high rate means "go
 * read the transcripts", never "add vectors". The L0 rows behind these counts
 * keep the surrounding conversation, which is the evidence (B) needs: most
 * tellingly, a miss followed by a reworded retry that hits.
 *
 * A cleverer counter would be the rejected trust formula in new clothes: a
 * number carrying a threshold nobody can justify.
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

  // Recall misses, counted from L0 rather than from a counter: the recall
  // tool's own result is already recorded there, so this is a query over data
  // we keep anyway (§9's "computed, never accumulated" rule).
  const recallCalls = one(
    store,
    `SELECT count(*) AS n FROM conversations WHERE label = 'tool:memory_recall'`,
  )
  const recallMisses = one(
    store,
    `SELECT count(*) AS n FROM conversations
     WHERE label = 'tool:memory_recall' AND text LIKE ? || '%'`,
    RECALL_NO_MATCH,
  )

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
    recallCalls,
    recallMissRate: recallCalls === 0 ? 0 : Number((recallMisses / recallCalls).toFixed(3)),
  }
}
