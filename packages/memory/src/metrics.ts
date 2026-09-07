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
 * A REJECTED CANDIDATE: a row the pipeline refused to admit, which therefore
 * was never active and which no reader ever saw.
 *
 * `status = 'superseded'` carries two unrelated populations, and only one of
 * them is an overturn:
 *
 *   A. rejected — `runReconcileJob`'s `drop` marks a CANDIDATE `superseded`
 *      and writes NO pointer. The row went `candidate -> superseded` without
 *      ever passing through `active`. This is the system correctly refusing
 *      noise: a HEALTH signal, not a misjudgement.
 *   B. overturned — a row that WAS active and has been replaced. Both writers
 *      that produce it write `superseded_by` in the same UPDATE as the status:
 *      `runReconcileJob`'s `supersedeOld` (`SET status = ?, superseded_by = ?`)
 *      and `service.propose({replaces})` (`SET status = 'superseded',
 *      superseded_by = ?`). There is no third writer of either column — grep
 *      `SET status` across `src/` returns seven `UPDATE memories` statements,
 *      and only those two set the pointer.
 *
 * So the pointer separates them, and nothing else in the row does: kind,
 * provenance and timestamps are all shared between the two populations.
 *
 * WHY THIS IS A PREDICATE AND NOT A STATUS VALUE. Splitting the two with a new
 * `'rejected'` member of `MEMORY_STATUSES` was implemented and rejected. The
 * status column carries a CHECK listing the enum, SQLite cannot widen a CHECK
 * in place, and so a new member only takes effect on stores built AFTER the
 * change: with the enum widened, a store created fresh at the current head
 * (`user_version = 12`) ACCEPTS `status = 'rejected'`, while all nine live
 * stores — which sit at `user_version = 11` and were built before it — REFUSE
 * it with `CHECK constraint failed: status IN (...)`, and `tsc` reports nothing
 * either way. Migrating them to 12 does NOT help: `migrateV12` rewrites the
 * derived-layer invalidation and never touches the status CHECK, so a fresh
 * v12 store WITHOUT that widening refuses the value exactly as v11 does. The first write to
 * reach a live store would be reconcile's `drop`, inside the single batch
 * commit — so one refused candidate would roll back every other candidate in
 * the batch and burn the job to a dead letter. Making it work needs a full
 * `rebuildMemories` of the one table `evidence.memory_id` cascades from. This
 * predicate buys the same distinction with zero migration.
 *
 * MEASURED, ACROSS THE NINE LIVE STORES. A and B are a complete, unambiguous
 * partition of `status IN ('superseded', 'archived')`: 66 A-rows and 50 B-rows
 * (38 `superseded` + 12 `archived`), with 0 dangling pointers, 0 `active` rows
 * carrying a pointer, and 0 `tombstone`/`dormant`/`candidate` rows carrying
 * one.
 *
 * WHY `archived` NEEDS NO TERM — a property of the write path, not of the data.
 * The reading agrees (12 of 12 archived rows carry a pointer), but a reading
 * only says what happened to be true when it was taken. The structural reason
 * is stronger: `grep -n "'archived'" src/` shows the whole package has ONE
 * writer of that status, `reconcile.ts`'s `oldRow.kind === 'procedure' ?
 * 'archived' : 'superseded'` — and that expression is the FIRST ARGUMENT of
 * `supersedeOld.run(...)`, whose UPDATE writes `SET status = ?, superseded_by =
 * ?` unconditionally. Status and pointer are set by one statement in one call,
 * so an `archived` row without a pointer cannot be constructed at all. No
 * INSERT writes the status either (the four `INSERT INTO memories` sites write
 * `'candidate'` or `'active'`), and `decay.ts` writes only `dormant`/`active`.
 *
 * That is also why adding an `AND status = 'superseded'`-style archived term to
 * this predicate is an IDENTITY rather than a tightening: the rows it would
 * exclude do not exist by construction.
 *
 * ⚠️ HONEST LIMIT — THIS IS WEAKER THAN A CONSTRAINT. Nothing in the schema
 * forbids a future writer from giving `drop` a pointer, and if one did, this
 * predicate would silently stop discriminating. What stands behind it is the
 * comment on `drop` itself plus the ONE test that pins the shape
 * ("overturnRate counts overturned memories…" in `test/layers.test.mjs`,
 * measured: giving `drop` a pointer turns that test red and leaves the other
 * 324 green) — and an author who changed the writer could change that test in
 * the same edit. It is strictly better than the status quo (which conflates the two
 * populations unconditionally, with nothing recording that it does), and it is
 * not a barrier anyone is prevented from walking around.
 *
 * Deliberately NOT hoisted into `types.ts` beside `MEMORY_STATUSES`. It drives
 * ONE metric, and a lifecycle constant parked in the shared vocabulary reads as
 * a rule every read surface should honour — the exact over-claim
 * `EXCLUDED_STATUSES`'s own comment there warns against. `reconcile.ts` names
 * this symbol in prose rather than importing it, because the pipeline must not
 * take a dependency on observability to write a row.
 */
export const REJECTED_CANDIDATE_SQL = `status = 'superseded' AND superseded_by IS NULL`

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
  // Excluded from BOTH sides of `overturnRate` below — see the field.
  const rejected = one(store, `SELECT count(*) AS n FROM memories WHERE ${REJECTED_CANDIDATE_SQL}`)
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
    // REAL misjudgements — memories that reached a reader and were then
    // overturned — which is what the §12 trust question asks and what this
    // module's own header promises ("real misjudgements").
    //
    // Rejected candidates (`REJECTED_CANDIDATE_SQL`) leave BOTH sides. They
    // share the `superseded` status with genuine overturns but nothing else:
    // they were never active, no reader ever saw them, and dropping one is the
    // pipeline WORKING. Counting them made the metric fail in its worst
    // possible direction — the more noise the system correctly refused, the
    // higher its own "misjudgement rate" read. A number that reports health as
    // failure is worse than no number, and §12 spends these on "should we
    // enable X".
    //
    // They leave the DENOMINATOR too, not just the numerator. Left below the
    // line they would still dilute the rate by an amount that varies with how
    // much noise the extractor happened to emit, which is a different reading
    // of the same accident rather than a fix.
    //
    // Measured across the nine live stores: the inflation is concentrated where
    // there is real pipeline traffic and absent where there is not. The two
    // busiest stores read 0.232 -> 0.102 (48 rejected, 2.27x) and 0.204 ->
    // 0.100 (17 rejected, 2.04x) — 2.0-2.3x too high, quoted as a RANGE because
    // the two are not the same number. SIX stores hold no rejected candidates
    // at all and do not move (0.091, 0.059, 0.079, and three at 0.000); the
    // ninth holds a single one and shifts 0.176 -> 0.125 (1.41x).
    //
    // Pooled over all nine the shift is 0.179 -> 0.086, i.e. 2.08x — a POOLED
    // figure, computed once over the summed populations, not an average of the
    // per-store ratios and not a rate any single store carries. It is DRIVEN BY
    // those two stores, which hold 65 of the 66 rejected rows. The honest
    // statement is "2.0-2.3x too high on the two stores with real pipeline
    // traffic, not measurably wrong on the six without any"; quoting the 2.08x
    // as though every store were inflated twofold would be the read-the-whole-
    // sample-off-the-busiest-store error this comment exists to prevent.
    overturnRate:
      active + superseded + archived - rejected === 0
        ? 0
        : Number(
            (
              (superseded + archived - rejected) /
              (active + superseded + archived - rejected)
            ).toFixed(3),
          ),
    pendingJobs: one(store, `SELECT count(*) AS n FROM jobs WHERE state = 'pending'`),
    oldestPendingJobAgeMs: oldestPending.n === null ? 0 : now - oldestPending.n,
    deadLettered: one(store, `SELECT count(*) AS n FROM jobs WHERE state = 'failed'`),
    recallCalls,
    recallMissRate: recallCalls === 0 ? 0 : Number((recallMisses / recallCalls).toFixed(3)),
  }
}
