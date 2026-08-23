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
 * What the next assembly would inject. A rollup, when one exists, REPLACES
 * the raw set it summarizes — that substitution is the whole point of the
 * derived layer. It exists only while the raw set overflows the budget and
 * is dropped by the next authoritative write, so this branch is normally
 * not taken.
 */
export const queryInjectionRows = (store: OpenStore): MemoryHit[] =>
  store.timed('inject-top-n', () => {
    const rollup = store.db
      .prepare(
        `SELECT id, kind, title, body FROM memories
         WHERE derived = 1 AND status = 'active' LIMIT 1`,
      )
      .get() as MemoryHit | undefined
    return rollup !== undefined ? [rollup] : queryInjectableSet(store, INJECT_TOP_N)
  })

/**
 * Escape user text into one FTS5 phrase: double internal quotes, wrap in
 * quotes. The query is data, never syntax (server-side MATCH construction,
 * spec §4.3).
 */
export const toFtsPhrase = (query: string): string =>
  `"${query.replaceAll('"', '""')}"`

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
  const terms = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
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
