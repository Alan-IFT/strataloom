/**
 * The two read-path queries (spec §2.3 — deliberately separate orderings):
 *
 * - injection top-N: NO query string exists on that path, so no FTS —
 *   provenance priority → updated_at DESC;
 * - recall: FTS rank → provenance priority → updated_at DESC, MATCH built
 *   server-side as an escaped phrase (spec §4.3).
 * @module @strataloom/dsh-memory/store/fts
 */
import type { OpenStore } from './store.ts'
import type { MemoryHit, MemoryKind } from '../types.ts'
import {
  EXCLUDED_STATUSES,
  INJECTABLE_PROVENANCE,
  LAYER,
  PROVENANCE_PRIORITY,
} from '../types.ts'
import { INJECT_TOP_N, RECALL_CANDIDATE_LIMIT } from '../constants.ts'

/**
 * SQL fragments are DERIVED from the typed constants in types.ts — one source
 * of truth. Inlining these lists as SQL literals would create a second place
 * the rules live, and the two would drift.
 */
const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ')

const priorityCase = (column: string): string =>
  `CASE ${column}\n${Object.entries(PROVENANCE_PRIORITY)
    .map(([provenance, rank]) => `  WHEN '${provenance}' THEN ${rank}`)
    .join('\n')}\n  ELSE 0 END`

const PRIORITY_CASE = priorityCase('provenance')
const PRIORITY_CASE_M = priorityCase('m.provenance')
const INJECTABLE_LIST = sqlList(INJECTABLE_PROVENANCE)
const EXCLUDED_LIST = sqlList(EXCLUDED_STATUSES)

/**
 * Both queries select exactly the columns their consumers read, so the rows
 * ARE the value objects — no row-shape mapper, and no columns fetched to be
 * discarded. Ordering columns stay in ORDER BY without being selected.
 */

/**
 * Injection working set: active, injectable provenance, priority order.
 * One millisecond-class SQL statement (spec §4.1).
 */
/**
 * The raw injectable working set: active, non-derived, injectable
 * provenance, in packet order. THE definition of "what would be injected
 * without a rollup" — the rollup builder and the metrics snapshot both read
 * it here rather than restating the rule, so the three cannot drift.
 * @param limit - row cap; the packet uses INJECT_TOP_N, the rollup takes more.
 */
export const queryInjectableSet = (store: OpenStore, limit: number): MemoryHit[] =>
  store.db
    .prepare(
      `SELECT id, kind, title, body
       FROM memories
       WHERE status = 'active' AND derived = 0
         AND provenance IN (${INJECTABLE_LIST})
       ORDER BY ${PRIORITY_CASE} DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as MemoryHit[]

/**
 * Everything a person should be able to see: active, non-derived, whatever the
 * provenance, newest first.
 *
 * Deliberately NOT `queryInjectableSet`. That one filters to injectable
 * provenance, which is right for the packet and wrong here — the memories a
 * user most needs to review are exactly the ones the pipeline wrote without
 * being asked, and several of those (subagent, tool-output) never reach the
 * packet. A review surface that hides what it learned quietly would defeat its
 * own purpose.
 *
 * Derived rows are excluded because they are regenerated summaries of the rows
 * already listed: showing both would double-count, and `forget` refuses them
 * anyway.
 * @param limit - row cap, so one enormous store cannot flood the caller.
 */
export const queryAllMemories = (store: OpenStore, limit: number): MemoryHit[] =>
  store.db
    .prepare(
      `SELECT id, kind, title, body
       FROM memories
       WHERE status = 'active' AND derived = ${LAYER.RAW}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as MemoryHit[]

/**
 * What the next assembly would inject. Derived rows, when they exist, REPLACE
 * the raw set they summarize — that substitution is the whole point of the
 * layer. They exist only while the raw set overflows the budget and are
 * dropped by the next authoritative write, so this branch is normally not
 * taken.
 *
 * Scenario blocks (L2) come back most-recent-first, and the renderer's budget
 * decides how many survive. There is deliberately no "pick the relevant one"
 * step: this path has no query string (spec §4.1), so relevance cannot be
 * computed here honestly, and the alternative — guessing from the agent's cwd
 * or last tool call — would be a second, weaker retrieval rule competing with
 * `memory_recall`. Recency is a signal we actually have, and the budget makes
 * the rest a non-question: a rebuild emits at most a handful of blocks, of
 * which the budget already admits most.
 *
 * ## Why the derived branch is capped at `INJECT_TOP_N`, and not at a constant
 * ## of its own
 *
 * Both branches are held by ONE ruler, deliberately. The load-time guard in
 * `recall/inject.ts` prices the worst packet by modelling the entry count as
 * `INJECT_TOP_N * 2` — `buildContextProvider` calls this function once per
 * side, personal and repo — and that sentence was true of the fallback branch
 * only. This branch used to return every active derived row, so the count it
 * contributed was a property of STORED CONTENT rather than of a constant, and
 * the guard could not see it: the packet is `[header, '', ...lines].join('\n')`,
 * i.e. `203 + 2 + 4 * INJECT_BODY_BUDGET_TOKENS + (E - 1)` characters at the
 * tightest, so `E = 40` prices to 1361 tokens (exactly what the guard reports)
 * while `E = 197` already exceeds `INJECT_PACKET_BUDGET_TOKENS` and an
 * unbounded branch reaches `E = 325` at 1433. A guard that reports a constant
 * while the container overflows is a false green, and nothing in the schema
 * bounds the number of derived rows — the CHECK constrains `derived` to a
 * layer value, never a count — so "the rebuild only ever emits a handful" is
 * an invariant of the write path alone, which is not a bound this read path
 * may assume.
 *
 * A separate `INJECT_DERIVED_TOP_N` would be a second number to keep in step
 * with §4.2 and the guard, i.e. the same rule written twice. Sharing
 * `INJECT_TOP_N` makes `E <= INJECT_TOP_N * 2` true for all four branch
 * combinations at once, which is one rule with two execution points (the
 * `worstPersonaTokens` precedent) rather than a duplicate.
 *
 * ## The `ORDER BY` is a display preference, and a guard is what keeps it one
 *
 * A LIMIT can promote an `ORDER BY` from a display preference to a SELECTION
 * PREDICATE — the clause stops fixing the sequence rows arrive in and starts
 * deciding which rows SQL discards. Here it does not, and the reason is
 * STRUCTURAL rather than a fact about how much data has accumulated so far:
 *
 * - The row count is bounded by the WRITER, at `ROLLUP_MAX_SCENARIOS + 1`.
 *   `pipeline/rebuild.ts` caps its blocks with a `.slice()` and writes them
 *   delete-then-insert, so replaying a rebuild replaces the layer instead of
 *   growing it; the portrait writer emits exactly one row and deletes any
 *   existing portrait first.
 * - Within ONE store, `derived` is effectively a constant column, so the
 *   leading sort key never compares anything: the persona branch is reached
 *   only for the global store (`runRebuildJob` early-returns on
 *   `store.kind === 'global'`), and the portrait's hardcoded `private`
 *   visibility is refused on a repo store by the `guard_visibility_insert`
 *   trigger.
 *
 * So this is not a time bomb waiting on data volume — derived rows CANNOT grow
 * past that sum. What the design actually depends on is the sum staying under
 * the window, and that is now ENFORCED: guard 3 in `constants.ts` asserts
 * `ROLLUP_MAX_SCENARIOS + 1 <= INJECT_TOP_N` at load. Raising the block cap
 * past the window fails the build rather than silently handing this clause the
 * power to evict an older L3 portrait from the packet. The numbers live in
 * those constants; restating them here would be the second copy that drifts.
 */
export const queryInjectionRows = (store: OpenStore): MemoryHit[] =>
  store.timed('inject-top-n', () => {
    const derived = store.db
      .prepare(
        `SELECT id, kind, title, body FROM memories
         WHERE derived != ${LAYER.RAW} AND status = 'active'
         ORDER BY derived DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(INJECT_TOP_N) as unknown as MemoryHit[]
    return derived.length > 0 ? derived : queryInjectableSet(store, INJECT_TOP_N)
  })

/** The CJK range the index bigram-expands. Mirrors `schema.ts`. */
const CJK_RUN = /[\u3400-\u9fff]+/g
const HAS_CJK = /[\u3400-\u9fff]/

/** Overlapping bigrams of each CJK run — the read side of what the index stores. */
export const cjkBigrams = (text: string): string[] => {
  const out: string[] = []
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) {
      out.push(run.slice(index, index + 2))
    }
  }
  return out
}

/**
 * Turn user text into an FTS5 query. The input is data, never syntax
 * (server-side MATCH construction, spec §4.3) — every part is quoted, so a
 * query containing `AND`, `OR` or `*` stays literal text.
 *
 * Latin is ONE quoted phrase, exactly as before. Chinese is expanded into the
 * same overlapping bigrams the index stores and AND-ed, because `unicode61`
 * emits one token per punctuation-delimited CJK run — which made every
 * re-wording of a stored Chinese memory unfindable. That is ONE rule with two
 * sides: the write side is SQL in `schema.ts`, this is the read side, and a
 * test asserts the two agree on the same input.
 */
export const toFtsPhrase = (query: string): string => {
  const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`
  if (!HAS_CJK.test(query)) return quote(query)
  const parts = cjkBigrams(query)
  // A mixed query still has to match its Latin words, which are indexed whole.
  for (const word of query.split(/[^\p{L}\p{N}]+/u)) {
    if (word !== '' && !HAS_CJK.test(word)) parts.push(word)
  }
  return parts.length === 0 ? quote(query) : parts.map(quote).join(' AND ')
}

/**
 * Recall query: 1 FTS pass + 1 primary fetch, joined here in a single
 * statement (still one FTS scan + rowid lookups). Excluded statuses stay out;
 * ALL provenances are eligible (tool-recall scope, spec §2.3 audience rule).
 */
export const queryRecallRows = (
  store: OpenStore,
  query: string,
  kind: MemoryKind | undefined,
): MemoryHit[] =>
  store.timed('recall-fts', () =>
    store.db
      .prepare(
        `SELECT m.id, m.kind, m.title, m.body
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ?
           AND m.status NOT IN (${EXCLUDED_LIST})
           AND (? IS NULL OR m.kind = ?)
         ORDER BY f.rank, ${PRIORITY_CASE_M} DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(
        toFtsPhrase(query),
        kind ?? null,
        kind ?? null,
        RECALL_CANDIDATE_LIMIT,
      ) as unknown as MemoryHit[],
  )

/**
 * Active memories of the same kind whose text overlaps the given title —
 * the "did we already record this?" probe used when saving.
 *
 * The title is split into words and OR-joined rather than matched as a
 * phrase: near-duplicates rarely repeat wording exactly, and this query only
 * *offers* candidates to the caller model, which then judges equivalence.
 * (The escaped-phrase rule guards the search TOOL, where the query is model
 * input; here the input is the caller's own title.)
 */
export const querySimilarRows = (
  store: OpenStore,
  title: string,
  kind: MemoryKind,
  limit: number,
): MemoryHit[] => {
  // Latin words as before; Chinese contributes its bigrams, because a CJK
  // title is a single "word" to the splitter and would otherwise probe with
  // nothing — near-duplicate detection would silently stop working in Chinese.
  const terms = [
    ...title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !HAS_CJK.test(word)),
    ...cjkBigrams(title),
  ].map((word) => `"${word.replaceAll('"', '""')}"`)
  if (terms.length === 0) return []
  return store.timed('propose-similar', () =>
    store.db
      .prepare(
        `SELECT m.id, m.kind, m.title, m.body
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active' AND m.kind = ?
         ORDER BY f.rank LIMIT ?`,
      )
      .all(terms.join(' OR '), kind, limit) as unknown as MemoryHit[],
  )
}
