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
 *   injectableTokens               → what this store OFFERS the next packet
 *   activeCount / retrievedRate    → dormant/decay (recall signal-to-noise)
 *   overturnRate                   → continuous trust (real misjudgements)
 *   recallMissRate                 → retrieval fusion (see the caveat below)
 *   oldestPendingJobAgeMs / deadLettered → pipeline health
 *
 * `injectableTokens` is an OBSERVATION, not the §12 derived-layer trigger. The
 * trigger is `packetOverflows` in `pipeline/rebuild.ts`, and it deliberately
 * prices a different container: this field prices the rows injection would
 * draw from (derived rows when they exist), while the trigger prices the raw
 * set the derived layer would be built FROM. Reading either as the other
 * inverts the answer — see `packetOverflows` for why the two must not
 * converge. What the field does NOT price is stated on the field itself.
 * @module @strataloom/dsh-memory/metrics
 */
import type { OpenStore } from './store/store.ts'
import { worstPersonaTokens } from './constants.ts'
import { queryInjectionRows } from './store/fts.ts'
import { RECALL_NO_MATCH } from './tools.ts'
import { packetTokens, withinBudget } from './recall/inject.ts'

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

  // Selected by the same per-store calls `buildContextProvider` makes, in the
  // same order, so what is priced is the set this store would hand injection —
  // not a plausible stand-in for it. Everything the packet does AFTERWARDS is
  // out of this snapshot's reach, and the field's own comment says so.
  //
  // `queryInjectionRows` — not the raw injectable set — because derived rows
  // REPLACE the raw set they summarize, so on a store with a derived layer the
  // raw set is not offered at all and its price answers no question anyone
  // asks. Measured across the nine live stores, the two containers give
  // opposite verdicts against `INJECT_BODY_BUDGET_TOKENS` on three of them.
  //
  // The global branch's `withinBudget` is NOT a budget invented here: it is
  // literally the step `recall/inject.ts` performs on the personal store's
  // rows before concatenation. Personal's fallback (raw atoms, when D9's
  // triggers have deleted the portrait) is capped at the cost of the portrait
  // it stands in for, so a metric that skipped the cap would report tokens the
  // packet never carries — on the live global store, off by a factor of 34.
  // One rule, two execution points: both sides call the same function with the
  // same bound, `worstPersonaTokens()`, so they cannot drift apart (that
  // function's own comment in `constants.ts` names this shape).
  //
  // The repo branch takes NO cap, and that asymmetry is half the rule rather
  // than an omission: the runtime caps personal alone, because personal is
  // what stands in for a deleted portrait. Capping repo rows here too would
  // hold them to a personal-side ceiling they never face, which on the live
  // stores collapses the number and on one of them zeroes it.
  const rows = queryInjectionRows(store)
  const injectable = store.kind === 'global' ? withinBudget(rows, worstPersonaTokens()) : rows

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
    // What this store OFFERS the next assembly, already past this store's own
    // ceiling. "Injectable", not "injected", and the difference is two things
    // this number deliberately does not know:
    //
    //   1. cross-store competition — personal and repo rows spend ONE packet
    //      budget together, and a single-store snapshot cannot see the other
    //      side;
    //   2. the packet budget's own trimming — `renderFramed(hits,
    //      INJECT_BODY_BUDGET_TOKENS)` runs on the CONCATENATED hits, after
    //      this snapshot's vantage point.
    //
    // So this value MAY EXCEED `INJECT_BODY_BUDGET_TOKENS`, and that is not an
    // anomaly to be clamped: it is a store offering more than the packet can
    // take, which is exactly the condition worth logging.
    //
    // Applying that budget here was considered and rejected three times over.
    // It would be a THIRD implementation of the selection rule `renderFramed`
    // already delegates to `withinBudget` — the D7-D9 shape this whole module
    // is being corrected for. It would not even be right: injection budgets
    // the two stores' rows jointly, so a per-store clamp is a different
    // approximation, not a closer one. And it would assert that this store
    // owns the whole budget, which is the shared-container error ADR 0007
    // records. The remaining gap is therefore real, known, and named here
    // rather than papered over — ADR 0009's rule that a promise not backed by
    // an implementation gets the PROMISE corrected.
    //
    // The global cap above is a different thing and stays: `worstPersonaTokens()`
    // is a per-store ceiling the runtime genuinely applies to this store alone.
    //
    // Named apart from `packetOverflows`'s input on purpose — one ruler
    // (`packetTokens`) is shared, one field name must not be, because a key
    // whose meaning depends on which reader holds it is the failure ADR 0009
    // §六(c) records.
    injectableTokens: packetTokens(injectable),
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
