/**
 * All runtime tuning constants in one place (spec §5.1: constants live
 * centrally, are NOT settings — they are P1-calibration parameters, not
 * design constants).
 * @module @strataloom/dsh-memory/constants
 */
import {
  estimateTokens,
  renderEntry,
  truncatedToBudget,
  SOURCE_LABEL_MAX_CHARS,
} from './recall/render.ts'
// `types.ts` imports nothing, so this cannot close a cycle the way importing
// from `inject.ts` would (see the note on `recall/render.ts`). The kind enum is
// read rather than quoted so the extract reply guard prices whatever kinds
// actually exist.
import { MEMORY_KINDS } from './types.ts'

/**
 * Re-exported because this is where every caller already imports it from
 * (`auto-extract.ts`, `recall/inject.ts`, `test/layers.test.mjs`). The
 * definition itself moved to the leaf module `recall/render.ts`, which imports
 * nothing, so the guards below can price a packet through the REAL renderer
 * without `constants → inject → constants` becoming a cycle.
 */
export { estimateTokens }

/** SQLite `application_id`: 'STLM'. */
export const APPLICATION_ID = 0x53_54_4c_4d

/**
 * Current schema version (v1 = P0 core, v2 = P1 jobs/usage/superseded_by,
 * v3 = L0 + global store, v4 = decay/derived, v5 = derived invalidation as a
 * data property rather than a write-path responsibility, v6 = `coding` kind, v7 = `derived` widened to a layer,
 * v8 = `jobs.last_error`, so a dead letter outlives the log line that explained it,
 * v9 = the FTS index is retokenized so CJK is searchable by re-wording, not only verbatim).
 */
export const TARGET_USER_VERSION = 9

/**
 * How much of a failure cause is kept on the job row. Long enough for an
 * error name plus its message, short enough that a runaway provider error
 * cannot bloat the row.
 */
export const JOB_ERROR_MAX_CHARS = 500

/** Per-connection busy timeout — waits happen at BEGIN IMMEDIATE (spec §3.3). */
export const BUSY_TIMEOUT_MS = 2_000

/** Immediate-transaction retry cap on SQLITE_BUSY (spec §10 busy retry 上限). */
export const IMMEDIATE_TX_RETRIES = 3
/** Base backoff between busy retries; scaled by attempt and jittered. */
export const BUSY_BACKOFF_MS = 50

/** Slow-statement warning threshold — the injection path's correctness companion (spec §9). */
export const SLOW_STATEMENT_MS = 50

/**
 * Injection body budget (spec §4.2: header + body ≤1400). The header is a
 * fixed string, so its size is a measurable fact rather than a budget to
 * enforce — `test/inject.test.mjs` asserts header + body stays under the
 * total instead of reserving an unused allowance for it.
 */
export const INJECT_BODY_BUDGET_TOKENS = 1_300
/** Top-N rows fetched for injection before budget truncation. */
export const INJECT_TOP_N = 20

/**
 * Ceiling for the tool-guidance section (`GUIDANCE_SECTION` in `tools.ts`),
 * enforced at load time there.
 *
 * 160 = the 153 tokens the section measures once the duplicated kind criteria
 * are gone, plus room for roughly one more sentence. It is deliberately tight:
 * the section's job is to say when to reach for three tools, and anything that
 * needs more room than that is documentation, which belongs in a schema
 * description or a doc — not in every request.
 *
 * This constant REPLACES the "≤150 tokens" prose in the spec (§7). That number
 * came from the initial commit with no measurement attached, and it was never
 * enforced: the section reached 245 tokens without anything noticing. 150 is
 * also simply wrong now — the surviving copy prices at 153 — so restating it
 * would have meant shipping a limit the correct text cannot meet. The spec now
 * points here, because a limit written in two places is the defect this whole
 * change is about.
 */
export const GUIDANCE_BUDGET_TOKENS = 160

/** FTS candidate cap for memory_recall (spec §4.3). */
/** Near-duplicate candidates offered back when saving. */
export const SIMILAR_LIMIT = 5

export const RECALL_CANDIDATE_LIMIT = 50
/**
 * What THIS repository's own rows may contribute to a recall result (spec §4.3).
 *
 * Read the name literally: it is the HOME container, not the packet. Until the
 * group feature existed those were the same thing, and `tools.ts` spending this
 * on every hit — home and foreign alike — is what made a per-member budget at
 * the service layer decorative (see `RECALL_PACKET_BUDGET_TOKENS`).
 */
export const RECALL_RESULT_BUDGET_TOKENS = 500
/**
 * The recall packet's REAL container, in CHARACTERS.
 *
 * This is the number the previous revision of this file did not have, and its
 * absence is exactly why the guard at the bottom was vacuous: that guard
 * compared the worst packet against `RECALL_RESULT_BUDGET_TOKENS x
 * (GROUP_MAX_MEMBERS + 1)`, which is not a container at all — it is an
 * expression in which the member count CANCELS (proof at the guard).
 *
 * The real one was found by following the value a model actually receives:
 *
 *     service.recall()          -> hits (structured)
 *     tools.ts  output.render() -> content: [{ type: 'text', text }]
 *     dsh-agent-loop            -> appendToolResult(..., result.content)
 *     dsh-llm                   -> createToolResultMessage({ content })
 *
 * `createToolResultMessage` puts `result.content` — and NOTHING else — into the
 * message (`@deepseek-ai/dsh-llm/lib/index.js:202`, reached from
 * `@deepseek-ai/dsh-agent-loop/lib/index.js:302`). The structured `value` never
 * reaches a model. So the rendered STRING is the entire product, and the first
 * thing downstream that truncates it is the platform's tool-result pruner,
 * configured identically at 8192 characters in
 * `@deepseek-ai/dsh-base/cordis.patch.yml` and in all three shipped agent
 * presets (code / cordis / standard). Past that threshold it keeps head 4096 +
 * marker + tail 1024 and DELETES the middle.
 *
 * Measured 2026-09-01 against a worst-case packet built at the constants this
 * file used to carry (home 500 + 8 members x 200):
 *
 *     rendered packet   8506 chars   403 entries
 *     after the pruner  5159 chars   231 entries
 *     silently deleted                172 entries
 *
 * That is ADR 0007's failure shape one layer further out, and it is why this
 * constant is denominated in CHARACTERS: the pruner counts Unicode code points,
 * so a token-denominated guard cannot see the cut at all.
 *
 * KNOWN COUPLING, recorded rather than hidden: this mirrors a platform default
 * that this package does not own, so a deployment which lowers `thresholdChars`
 * makes this guard optimistic. That is still strictly better than what it
 * replaces — a guard modelling a container that does not exist — and what the
 * guard PRICES is a real packet rendered through the real `renderFramed`, so
 * the only thing that can drift is the threshold, never the pricing.
 */
export const RECALL_PACKET_MAX_CHARS = 8_192
/**
 * Rows `/memory` lists per scope. Generous: the point of that command is
 * completeness, so the cap is a guard against flooding a chat with an enormous
 * store, not an editorial filter.
 */
export const LIST_LIMIT = 200
/**
 * What ONE group member repository may contribute to a recall result.
 *
 * PER LIBRARY, deliberately, and that is the entire design. The alternative —
 * letting foreign rows compete for the single `RECALL_RESULT_BUDGET_TOKENS`
 * container — is ADR 0007's defect with different labels: measured over the
 * real stores, a shared container let foreign rows displace this repo's own
 * memories in 33.1%-40.9% of queries. A budget per member makes the home
 * repository's result a function of the home repository alone.
 *
 * 220, and it is the MAXIMUM OF TWO derivations — a measured knee and an
 * enforced floor — rounded up. The first was measured, the value was set to it,
 * and then the load-time guard at the bottom of this file rejected it. The
 * guard was right and the measurement was incomplete; the constant moved rather
 * than the invariant (ADR 0007: 常量跟随不变量走). It moved a second time, for
 * the same reason, when the renderer began emitting a `(from …)` label — see
 * "the label raise" below.
 *
 * ## Derivation 1 — the coverage knee (150)
 *
 * Measured 2026-09-01 over the three declared members of the real `NFBY_CMS`
 * group (59 distinct active non-derived rows), priced through the real
 * `renderEntry` with `withId=true` — the ruler the recall tool actually renders
 * by (ADR 0009: measure at the outermost ruler, never at the SQL exit):
 *
 *     row cost (tokens)   min 85   p25 110   p50 125   p75 135   p90 151   max 186
 *
 *     budget   rows that fit alone   seeds gaining foreign   foreign delivered
 *        50          0/59  (0.0%)           0/1412                    0
 *       100          6/59 (10.2%)         174/1412                  178
 *       125         38/59 (64.4%)         634/1412                  740
 *       150         53/59 (89.8%)         848/1412                 1079
 *       175         56/59 (94.9%)         879/1412                 1134
 *       200         59/59 (100%)          898/1412                 1186
 *       300         59/59 (100%)          900/1412                 1378
 *       500         59/59 (100%)          901/1412                 1540
 *
 * The curve has a knee, and it is sharp. Below 150 the budget is BELOW the
 * median row: 50 admits literally nothing (the cheapest foreign row costs 85),
 * and 100 reaches 10.2% of rows — a budget that mostly buys an empty result is
 * worse than no feature, because it looks like the group is not configured.
 * From 150 to 500 the delivered count rises 1079 → 1540 (+42.7%) while the
 * seeds that gain anything at all rise 848 → 901 (+6.3%): past the knee the
 * extra budget is spent making already-served queries longer, not serving new
 * ones. 150 buys 94.1% of the coverage 500 buys, for 30% of the ceiling.
 *
 * The queries are 1412 seeds generated MECHANICALLY from stored titles (Latin
 * words >= 4 chars, CJK bigrams, deduped) rather than chosen by hand, so the
 * curve carries no selection bias toward terms known to work.
 *
 * ## Derivation 2 — the enforced floor, which is why this is not 150
 *
 * The measurement above sampled the rows that EXIST. It could not see the rows
 * the write path is permitted to CREATE. A member store's L2 scenario blocks
 * are written at `ROLLUP_TITLE_TARGET_CHARS` + `ROLLUP_TARGET_CHARS`, and
 * priced the way recall renders them — with the id, with a `(from …)` label at
 * its `SOURCE_LABEL_MAX_CHARS` ceiling, and with the body's own newlines
 * indented — one such block costs 212 tokens:
 *
 *     worst L2 block, withId=false (injection's ruler)              183
 *     worst L2 block, withId=true  (recall's ruler)                 194
 *     worst L2 block, withId=true + worst source label (this one)   212
 *
 * ### The label raise: 200 -> 220
 *
 * Attribution is not free and the guard priced it immediately. Adding
 * `(from <source>) ` to a foreign entry costs at most
 * `SOURCE_LABEL_MAX_CHARS + 8` characters, so the enforced floor rose 194 ->
 * 212 and the load-time guard REJECTED the shipped 200 the moment the renderer
 * changed:
 *
 *     strataloom: RECALL_FOREIGN_BUDGET_TOKENS (200) cannot admit even one
 *     worst-shaped foreign row (212 tokens rendered with its id)
 *
 * That is the guard doing exactly the job its own history describes — the
 * feature would have been on, approved, and silently empty for a member holding
 * only scenario blocks. `max(150, 212) = 212`, rounded up to 220. The rounding
 * is not slack for its own sake: it leaves a round number that need not move
 * for a one-token change in the label format, while the packet guard in
 * `tools.ts` re-derives the container bound from it at every load.
 *
 * At 150 an approved group whose member holds only scenario blocks returns
 * NOTHING — the feature would be on, approved, and silently empty, which is
 * precisely the "green guard, zero product effect" failure ADR 0007 lesson 4
 * records. `withinBudget` skips an oversized row whole, so this is not partial
 * degradation; it is total.
 *
 * 150 measured 89.8% of today's rows fitting and read like the knee. Its p90
 * (151) already sat above it — the tail was visible in the data and I still
 * chose the knee, because "89.8% of rows fit" sounds like most of the value.
 * It is not: the 10.2% that do not fit are the DERIVED rows, i.e. exactly the
 * summaries a foreign repository contributes once it has enough content to
 * summarise. The guard caught this; the replay did not, because no member store
 * in the sample had scenario blocks matching the enforced target.
 *
 * So the value is `max(knee, worst enforced row)` rounded up: `max(150, 194)`
 * → 200 originally, and `max(150, 212)` → 220 once entries carry their source.
 * Cost of the first raise, measured on the same 1412 seeds: foreign entries
 * delivered 1079 → 1186 (+9.9%), queries gaining anything 848 → 898 (+5.9%),
 * mean rendered result 266.2 → 280.3 tokens (+5.3%). It buys correctness for a
 * one-row case at about 5% more tokens — and the home side is unaffected either
 * way (1401/1401 identical at every value tested).
 *
 * ## What this budget is NOT: a claim about the rows that exist
 *
 * Both derivations above are honest about their own scope, and the consequence
 * is worth stating plainly because a later reader WILL be tempted to "tune"
 * this number against the store on their disk. Measured over the real stores:
 * the 17 active L2 blocks have bodies of 317-1820 characters and cost 96-483
 * tokens at recall's ruler, so only 7 of 17 fit this budget and the rest are
 * skipped whole. Those blocks predate `rebuild.ts`'s `.slice()` clamp, so they
 * are larger than the write path can now produce — and raising this constant to
 * admit them is NOT the conclusion. The value is bounded above by the packet
 * container (`GROUP_MAX_MEMBERS` falls as this rises), and the rows that carry
 * foreign coverage are L0/L1: those fit 59/59 and outnumber L2 in foreign
 * delivery by roughly 1564 to 80. ADR 0011 §5 carries the full distribution and
 * the discard rate.
 */
export const RECALL_FOREIGN_BUDGET_TOKENS = 220
/**
 * The most members one declaration may name.
 *
 * 6, and it is DERIVED rather than chosen: it is the largest value at which the
 * worst rendered recall packet still fits `RECALL_PACKET_MAX_CHARS`. The guard
 * that establishes this lives in `tools.ts`, beside the render call it prices,
 * and it is a real inequality — raising this constant to 7 makes the plugin
 * throw at load. Measured by building the packet through the production
 * `renderFramed`, at the current `RECALL_FOREIGN_BUDGET_TOKENS` of 220:
 *
 *     members   worst packet chars   vs 8192
 *           5                7004    fits
 *           6                7939    fits (253 spare)
 *           7                8874    THROWS
 *           8                9809    THROWS
 *
 * The spare margin fell from 763 to 253 when entries began carrying a `(from
 * …)` source label and the per-member budget rose 200 → 220 to keep admitting
 * one worst-shaped row. 6 survived that raise; it matters that it was
 * RE-DERIVED rather than merely left alone, because the next widening of an
 * entry's rendered shape is what takes this to 5, and the guard — not a reader
 * — is what will say so.
 *
 * It was 8 in the previous revision, under a guard that could not fail. That
 * guard compared `500 + N x 200` against `500 x (N + 1)`, in which N cancels
 * (`N·F > N·R  <=>  F > R`), so it certified N = 100000 — a 20,000,500-token
 * worst case — without a murmur. 8 was never checked by anything; it only
 * looked checked. The number moved because the invariant became real, which is
 * the direction ADR 0007 requires (常量跟随不变量走).
 *
 * The real case that motivated the feature declares 3 members, so 6 is still
 * 2x headroom. The point is not that 6 is special: it is that the value is now
 * the answer to a question a machine asks at every load.
 */
export const GROUP_MAX_MEMBERS = 6
/**
 * The budget the recall tool renders the WHOLE packet with — home plus members.
 *
 * Derived, never typed: it is exactly the sum of the containers the service
 * layer has already spent, so by construction this render can never clip a row
 * the service admitted. That is the point. Previously `tools.ts` rendered every
 * hit — home and foreign alike — against `RECALL_RESULT_BUDGET_TOKENS`, which
 * made the per-member budget beneath it purely decorative: the outermost ruler
 * was a SHARED container, so foreign delivery was a function of how much this
 * repository happened to match. Measured over 1936 mechanically generated seeds
 * against the four real stores, foreign rows reaching the model:
 *
 *     home tokens in the result   seeds gaining a foreign row (shared ruler)
 *                             0                                        97%
 *                         1-249                                        49%
 *                       250-499                                        25%
 *                       500-999                                        23%
 *                        >=1000                                         6%
 *
 * An approved, human-gated feature that silently returns nothing precisely when
 * this repository is well-stocked is ADR 0007 lesson 4 (green guard, zero
 * product effect) welded to ADR 0009 (measure at the outermost ruler). Under
 * the split containers the same replay delivers 65% -> 75% at the >=1000 end
 * and 2263 foreign rows against 1844, with home delivery byte-identical to the
 * group-off baseline on all 1936 seeds.
 *
 * Rejected alternative — carve a foreign floor OUT of the 500 (i.e. home 300 +
 * foreign 200). It was implemented and measured, and it BREAKS the zero-
 * regression gate: home delivery diverged from the group-off baseline on
 * 521/1936 seeds, losing 612 home rows. Reserving for the guest by taxing the
 * host is the eviction this design exists to forbid, so the data refused it.
 */
export const RECALL_PACKET_BUDGET_TOKENS =
  RECALL_RESULT_BUDGET_TOKENS + GROUP_MAX_MEMBERS * RECALL_FOREIGN_BUDGET_TOKENS
/**
 * Rows returned by the FALLBACK path of memory_recall's drill-down
 * (`sourceOf`) — the one taken only when the cited evidence row carries no
 * stored quotation.
 *
 * SCOPE CHANGED, and everything below must be read under the new scope. This
 * used to govern the only path `sourceOf` had. `service.source` now returns
 * `evidence.excerpt` — the passage the extractor actually cited — whenever one
 * exists, and that path ignores this constant entirely: it is one hit, whole,
 * unsplit, with no row budget to spend. This limit now governs the remaining
 * cases only, which are not rare: 80 of 403 real evidence rows (19.9%, all
 * `principal-explicit`) have no excerpt, so about a fifth of reads land here.
 *
 * The reason the primary path exists at all is that this one does not answer
 * the question the tool asks. It reads the session's LAST rows, while cited
 * lines are spread evenly through a session (p25=0.24 / p50=0.57 / p75=0.80):
 * 9.3% of cited passages fell in the window, and 6-8% survived to the model.
 * That is a property of the ANCHOR, not of the row count — which is exactly
 * why raising this constant was measured and found inert (ADR 0009 §6(a)), and
 * why it must not be re-raised in the hope of fixing coverage. For the rows it
 * does deliver — surrounding context, honestly labelled as such — the
 * derivation below still holds, and it is still the right value.
 *
 * MEASURED NON-BINDING (ADR 0009). These rows are rendered through the recall
 * tool's renderer, and that budget truncates first: an L0 row costs p50=41 but
 * p90=516 tokens, and 10.2% of rows exceed 500 on their own. Replayed across
 * all 11 cited sessions, raising this value moves delivery from a mean of 6.45
 * rows (at 20) to 6.82 (at 34) to 7.64 (at 100), and 100 to 5000 changes
 * nothing at all. Coverage of the actually-cited lines does not move.
 *
 * That render budget is `RECALL_PACKET_BUDGET_TOKENS` rather than
 * `RECALL_RESULT_BUDGET_TOKENS`, and the effect on THIS path was measured
 * rather than assumed: replayed over the 13 real L0 sessions on this machine,
 * delivery rises from a mean of 11.92 rows to 14.92 (+25.2%), changing 12 of
 * 13. That is a widening of the drill-down window, and it is ACCEPTABLE for the
 * reason the derivation below already gives — `sourceOf` answers 核对原话, and
 * the limit it was fighting was never the row count but the renderer's budget.
 *
 * It is also SAFE against the container: `sourceOf` carries no per-store budget
 * of its own, but `renderFramed` spends the same token budget whatever the hits
 * are, and the packet guard in `tools.ts` prices the maximum characters that
 * budget can buy (4 chars per token, tight). That guard is the live authority
 * on the number and `worstRecallPacketChars()` reports it — deliberately not
 * restated here, because the two numbers this paragraph used to quote (a
 * budget of 1700, a worst case of 7429) had both been stale since the budget
 * last moved, while the test that checks the bound called the function and
 * stayed green. The largest real L0 packet measured 6998 characters against
 * the 8192 container. The bound covers both modes of the tool, not just the
 * group case it was derived for; the quotation path is far cheaper still
 * (max 471 tokens rendered, 2086 characters, over all 322 real excerpts).
 *
 * So the derivation kept below is not wrong — it measured row density at the
 * SQL exit accurately, and raising 20 to 34 really does fetch +93.5% more
 * window text. That layer simply is not the last one. Eight of the eleven
 * sessions deliver a byte-identical set at 20 and at 34; coverage of the
 * actually-cited lines is unchanged at every limit.
 *
 * The raise is therefore not free but inert: it lifts the wasted-fetch rate
 * from 88.7% to 94.0% (raw fetch +91% per call) while delivery stays near the
 * 500-token ceiling. Do not re-derive this constant without replaying through
 * `renderFramed` — the SQL exit will keep reporting progress that no caller
 * receives.
 *
 * 34, raised from 20 by the `tool/call` capture, and the raise is a CORRECTION
 * rather than a widening: this is a ROW budget over a table whose row density
 * changed, so leaving it alone silently shrinks the window's content.
 *
 * The reason it needed changing at all — and the reason it was nearly missed —
 * is that L0 has consumers with two different rulers. `extract` budgets in
 * CHARACTERS (`EXTRACT_TRANSCRIPT_CHARS`), so it re-balanced itself the moment
 * rows got denser, and that cost was measured to the percentage point. This one
 * budgets in ROWS, so it absorbed the whole density change as lost conversation
 * and reported nothing. Measured over 140 real sessions replayed through both
 * builds, at the unchanged limit of 20:
 *
 *     L0 rows per session      148.2 -> 248.5     (+67.7%)
 *     window text chars      3631314 -> 2385984   (-34.3%)
 *     assistant rows kept        547 -> 358       (-34.6%)
 *
 * A third of the drill-down's substance, from a change whose entire purpose was
 * to record MORE. `sourceOf` is the path that answers 核对原话 — the one that
 * makes provenance checkable rather than merely claimed — so the loss lands
 * exactly where the evidence is supposed to be.
 *
 * The new value is DERIVED from that density, not chosen to make a number go
 * green: the window must hold as much conversation as it did before, so
 *
 *     20 x (248.5 / 148.2) = 20 x 1.677 = 33.5
 *
 * and 34 is that rounded UP — rounding down would restore slightly less than
 * existed before. Replaying the same sessions confirms the derivation by a
 * second route: break-even falls between 32 (-2.3%) and 33 (+0.3%), and 34
 * measures +3.4% chars / +3.8% assistant rows against the old window. The
 * derivation and the measurement agree to within one row.
 *
 * Excluding the `tool-call:` family from this query was the rejected
 * alternative. It would hold the count at 20 and cost nothing — but those rows
 * are 38.3% of the window precisely because they are what the agent DID, and
 * someone checking a memory's provenance has as much reason to see the call as
 * the result it produced. Filtering them here would re-create, at the read end,
 * the exact blindness this whole change exists to remove.
 */
export const SOURCE_TURN_LIMIT = 34

/** Enqueue gate: minimum new user/assistant text tokens in a turn (spec §5.1). */
export const ENQUEUE_MIN_TURN_TOKENS = 200

/** Job lease duration (spec §5.2). */
export const LEASE_DURATION_MS = 5 * 60_000
/** Cooperative job timeout — a duplicate-work reducer, NOT a correctness bound (spec §5.2). */
export const JOB_TIMEOUT_MS = 4 * 60_000
/** Claims allowed before dead-letter (spec §5.2: 认领后 attempts > 5 ⇒ failed). */
export const MAX_CLAIMS = 5
/** Runner tick interval (spec §5.2). */
export const TICK_INTERVAL_MS = 30_000
/** Retry backoff per accumulated claim. */
export const RETRY_BACKOFF_MS = 60_000

/** Low-frequency jobs-table cleanup interval (P1: tick-driven, spec §5.2). */
export const CLEANUP_INTERVAL_MS = 6 * 3_600_000
/** Retention for done jobs. */
/** Active + unretrieved for this long ⇒ dormant (spec §12 decay). */
export const DECAY_IDLE_MS = 60 * 86_400_000
/** A dormant memory hit within this window revives. */
export const DECAY_REVIVE_MS = 14 * 86_400_000
/*
 * `EXCERPT_COMPACT_MS` (30 days) was DELETED here, not raised, and the reason
 * is recorded so it is not reintroduced.
 *
 * It nulled `evidence.excerpt` for memories untouched for 30 days, on the
 * theory that a quote nobody reads is storage nobody needs. `service.source`
 * now reads that column as its PRIMARY evidence path, which turns the same
 * statement from "drop an unread column" into "destroy the proof D3 promises".
 *
 * The invariant it violated is that EVIDENCE MUST NOT DIE BEFORE THE MEMORY
 * IT SUPPORTS OR THE WORDS IT QUOTES. Note what that is NOT: it is not "the
 * excerpt died 60 days before L0's 90". `pruneConversations` exempts any
 * session a surviving memory cites, so a cited conversation is never pruned
 * at all — measured over the 9 real stores, 6273 of 6321 L0 rows (99.2%) are
 * held by that exemption. The gap was therefore not 60 days but unbounded:
 * the evidence expired while the words it quoted lived forever.
 *
 * Raising it to 90 days was rejected for the same reason. Against a lifetime
 * with no upper bound, any finite window is either a data-loss bug or code
 * that can never fire.
 *
 * Deleting rather than re-timing is the D7-D9 point. "How long evidence lives"
 * is a fact ALREADY defined, once, by `pruneConversations`'s exemption clause;
 * a second independent rule for the same fact is exactly the duplicate
 * implementation the design rules forbid, and this is what it looks like when
 * the two copies drift.
 *
 * Urgency, measured rather than assumed: the rule was clearing 0 rows, so
 * nothing observable had broken yet. The oldest memory carrying an excerpt has
 * `updated_at = 2026-08-23T15:29:03.655Z` (9 stores, read 2026-09-01), so the
 * rule begins biting 2026-09-22 and would blank all 322 excerpts over the
 * following 30 days. Shipping the read-path fix without this deletion would
 * have restored today's behaviour automatically three weeks later — silently,
 * with every test still green.
 */
/** Below this many active memories a store has no noise problem to solve. */
export const DECAY_MIN_ACTIVE = 50
/** Memories fed into one rollup (spec §12 derived layer). */
export const ROLLUP_SOURCE_LIMIT = 200

/**
 * Character cap on the memories handed to one rollup — the input-side twin of
 * `EXTRACT_TRANSCRIPT_CHARS`, which `rollup` never had.
 *
 * The derived layer exists BECAUSE the injectable set overflows its
 * 1300-token budget, so its trigger is bounded while the prompt built from it
 * was not: the larger the overflow, the larger the request, without limit.
 * Measured on a live store — 27 memories became a 12574-character prompt
 * (4769 of them Chinese, so ~6.7k tokens), and together with the ~5.9k
 * characters the prompt invites back it finished as `max-tokens`. Raising the
 * output cap again would work around the same root cause a second time;
 * bounding the input removes it.
 *
 * Rows arrive in packet order (provenance, then recency), so a rollup that
 * hits this cap summarises the memories the packet itself would have injected
 * first — the truncation follows the ordering that already exists rather than
 * inventing a second one.
 */
export const ROLLUP_TRANSCRIPT_CHARS = 6_000

/* `DECAY_INTERVAL_MS` used to sit here, and nothing ever read it. Decay's
   once-per-day cadence is not a comparison against an interval — it is the
   idempotence key `jobId('decay', repoKey, <YYYY-MM-DD>)`, so a second enqueue
   on the same day collapses into the row that already exists. A constant that
   states a rule the code implements elsewhere is a second source of truth
   waiting to drift; removed rather than wired up. */

/**
 * L0 conversation retention — the age half of `pruneConversations`'s
 * predicate, and TODAY IT DECIDES NO DELETIONS AT ALL.
 *
 * This comment used to end "but not forever". Measured over the 9 real stores
 * on 2026-09-01, forever is exactly what it is: the exemption clause held
 * every L0 row in every non-empty store (8 of the 9; the global store has no
 * rows and so offers no evidence either way), and forcing the cutoff wide
 * open deleted nothing. The clause above this one, not this constant, is what
 * bounds L0 — see the `EXCERPT_COMPACT_MS` epitaph earlier in this file, which
 * already states the same fact correctly ("a cited conversation is never
 * pruned at all … the gap was therefore not 60 days but unbounded"). Two
 * opposite claims about one fact lived in this file; this is the wrong one.
 *
 * Kept, not deleted, because it is the only protection keyed on a row's AGE.
 * Removing it would not turn a no-op into a no-op — it would start deleting
 * every conversation that has not yet produced evidence, which is the window
 * between capture and extract. `pruneConversations` carries that argument.
 */
export const L0_RETENTION_MS = 90 * 86_400_000

export const DONE_RETENTION_MS = 7 * 86_400_000
/** Retention for dead-lettered jobs. */
export const FAILED_RETENTION_MS = 30 * 86_400_000

/** Max candidates one extract may produce. */
export const EXTRACT_MAX_CANDIDATES = 5
/**
 * Per-event excerpt cap in the extract transcript — and, since the `tool/call`
 * capture, the ROW cap the capture path enforces as well.
 *
 * One number, two execution points, on purpose (the `worstPersonaTokens`
 * precedent): extraction cuts every event to this, so this is the most of any
 * row that can EVER be read. Storing a longer row would be storing bytes with
 * no reader — L0 pays the disk and the extract prompt still sees 400
 * characters. That is the invariant behind `summarizeArguments`' row bound:
 * "what capture keeps" is bounded by "what extraction can see", rather than by
 * a second number chosen to look similar.
 *
 * Not applied to the OTHER capture paths, and that asymmetry is the design: a
 * user message or a tool result is a fact whose full text L0 exists to
 * preserve for the drill-down `store/conversations.ts` documents (spec: L0
 * answers 核对原话/时间/来源), and truncating it at capture would destroy
 * evidence to save nothing. A `tool/call` summary has no such second
 * reader — it is synthesised here, from an event the platform log already
 * holds verbatim — so the cheapest correct bound is the only one it needs.
 */
export const EXTRACT_EVENT_EXCERPT_CHARS = 400
/**
 * Longest `tool/call` argument VALUE kept verbatim; longer ones are recorded
 * as `<N chars>` (see `transcript.ts: summarizeArguments`).
 *
 * A TRADEOFF on a heavy-tailed distribution, not a feature of its shape.
 * Measured over 35829 values from 13961 real calls, in EQUAL-WIDTH buckets:
 *
 *     [  0, 20) 33.0%   [ 80,100) 2.9%   [160,180) 1.5%   [240,260) 1.0%
 *     [ 20, 40) 18.7%   [100,120) 2.2%   [180,200) 1.3%   [260,280) 0.9%
 *     [ 40, 60) 11.3%   [120,140) 2.2%   [200,220) 1.1%   [280,300) 0.8%
 *     [ 60, 80)  6.3%   [140,160) 1.8%   [220,240) 1.1%
 *
 *     median 38   p75 124   p90 431   p95 930   p99 3034   max 48979
 *
 * The density falls monotonically — 11840 → 6686 → 4033 → 2254 → 1029 → 778 —
 * roughly 20x across the first six buckets, and there is NO second mode. An
 * earlier draft of this comment claimed a "bimodal" distribution with 120 in
 * the trough; that reading was an artifact of unequal buckets (a 20-wide
 * `[100,120)` printed beside a 40-wide `[120,160)`). The only rise in this
 * range is `[120,140)` at +3.0% over its neighbour, which is noise: the same
 * scan shows fifteen rises of equal or larger size further out (+96% at
 * `[500,520)`, +22% at `[660,680)`). Stating it as a trough would be a
 * conclusion stronger than the evidence, and the number would then be resting
 * on a shape that is not there.
 *
 * What the number actually rests on is the cost curve, which is real:
 *
 *     cap    values kept verbatim    total bytes kept verbatim
 *      80          69.3%                    628048
 *     120          74.4%                    807266
 *     160          78.5%                   1009564
 *     200          81.2%                   1185859
 *
 * Going 120 → 200 buys 6.8 points of coverage for 47% more verbatim bytes, and
 * those bytes are spent inside `EXTRACT_EVENT_EXCERPT_CHARS`, where they
 * displace other fields of the same call. Going 120 → 80 saves 22% of the
 * bytes and gives up 5.1 points, on values that are short anyway. 120 is the
 * knee of that curve rather than a feature of the histogram: it keeps the
 * things worth quoting (a path, a query, a description, a flag) and refuses
 * the tail, where no truncation length is informative and the LENGTH is the
 * only part worth recording.
 *
 * It is a VALUE bound, deliberately paired with the row bound above rather
 * than replacing it: a call with thirty short fields passes every value check
 * and still writes a long row. Two levels, because they answer two different
 * questions — "is this value worth quoting?" and "can extraction read this
 * row at all?".
 */
export const TOOL_CALL_VALUE_CHARS = 120
/**
 * Total transcript cap handed to the extract prompt.
 *
 * 5300, and unlike its predecessor it is DERIVED. 6000 came in with the
 * initial commit (`37c73f5`) and `git log -S` finds no later change and no
 * argument for it: it was a number typed once. The bound that actually exists
 * is the one the guard below now executes — the extract exchange, input plus
 * the reply the prompt invites, must fit `LLM_MAX_TOKENS`:
 *
 *     EXTRACT_TRANSCRIPT_CHARS + worstExtractReplyChars() <= LLM_MAX_TOKENS
 *
 *     5300 + 6682 = 11982 <= 12000
 *
 * ## Why this number went DOWN three times
 *
 * The reply term is BUILT AND MEASURED (see `worstExtractReplyChars`), and
 * every time an assumption inside it was actually checked, the ceiling fell:
 *
 *     scaffolding "+60 per candidate", 4-digit seqs   ceiling 7100  (estimated)
 *     constructed; quote-class escapes, 4-digit seqs  ceiling 6558  (measured)
 *     + 6-digit seqs, control-class escapes           ceiling 5318  (measured)
 *
 * Round one wrote the scaffolding as a flat `+ 60` and shipped 7000 beneath a
 * comment conceding that 60 was "an estimate, not a measured maximum, since a
 * title carrying escapes costs more than its length" — the risk named in
 * writing, the assumption never checked. Round two constructed the candidate
 * and found 165, putting 7000 over the real ceiling by 442. Round three found
 * that the construction ITSELF still carried two unchecked assumptions:
 *
 * - **seq width.** It used 9999, called four digits "the widest a realistic
 *   transcript produces", and the store disagrees: 74.8% of 3312 real L0 seqs
 *   are already wider, the largest is 126635, and 30 of 145 platform logs
 *   exceed 9999. A seq counts a session's lifetime; it was never 4 digits.
 * - **escape CLASS, not just rate.** It priced `"` at +1. A `\u001f` control
 *   character costs +5, and title/body are free model text. Stored rows contain
 *   zero of them today — the same "true right now" that this file has already
 *   been burned by twice.
 *
 * The second is the dominant term: at the same 6% rate it alone moves the
 * ceiling 6602 → 5462, while seq width moves it ~140 and the tenth `sourceSeq`
 * ~140. Priced against MEASURED reality instead (0.44% escapes, all
 * quote-class, 6 seqs) the ceiling would be 6867 — so this constant is carrying
 * roughly 1550 characters of deliberate pessimism, and that is the intended
 * direction: the guard protects a provider's hard limit, where being wrong
 * costs an unparseable reply and a dead-lettered job.
 *
 * ## What it costs, stated plainly
 *
 * 5300 is BELOW the original 6000, so the transcript budget is genuinely
 * smaller than before this whole change. Measured over 48 real sessions, the
 * fix still nets out well ahead because `skip` and the tool-call rows more than
 * pay for the narrower window:
 *
 *     baseline 6000 + break + no tool/call   kept 2704   (asst 837, res 1636)
 *     this      5300 + skip  + tool/call      kept 3021   (asst 635, call 1133)
 *
 * +11.7% events overall, and 1133 tool calls that did not previously exist
 * anywhere in L0 — bought with 24% fewer assistant rows. That is a real cost,
 * recorded rather than hidden: an honest bound that shrinks the budget is still
 * better than a generous one that lets a provider truncate the reply.
 */
export const EXTRACT_TRANSCRIPT_CHARS = 5_300
/** Existing-memory context cap for reconcile. */
export const RECONCILE_EXISTING_LIMIT = 30
/**
 * Output token cap for pipeline LLM calls.
 *
 * It must exceed what the prompts ASK FOR, or the cap truncates a reply the
 * prompt itself invited — and since every reply is parsed as a whole
 * structure, a truncation is not a shorter answer but an unusable one. A live
 * model hit this: `rollup` asks for up to `ROLLUP_MAX_SCENARIOS` scenarios of
 * `ROLLUP_TARGET_CHARS` each, which alone exceeds 1000 tokens, and three
 * replies in five came back cut mid-string.
 *
 * (Those two names read as `${…}` here until recently, which looked like
 * interpolation but is a doc comment — the numbers would never have updated
 * themselves. They are named rather than quoted now, so the text stays true
 * whatever the constants say; the arithmetic that must track them lives in the
 * assertions below, where it is executed rather than described.)
 *
 * The value is generous rather than tight on purpose: this is a guardrail
 * against a runaway reply, not a budget. The real cost control is the input
 * side (transcript and source limits) and the fact that these jobs are rare.
 *
 * 4000 was too small, and the guard said otherwise because it priced the
 * worst reply at `chars/4 * 2` while its own comment records that CJK is
 * nearer ONE token per character — a 2x understatement in exactly the language
 * this store holds. Measured: of four `rebuild` jobs ever run, the two with
 * small inputs finished on attempt 1, while the one summarising 27
 * mostly-Chinese memories burned all six, and extract/reconcile/decay went
 * 68/0 across the same routes and days.
 *
 * 8000 was still too small, and this time the store said so directly: after
 * the restart the revived rollup recorded `stream finished as max-tokens` in
 * `jobs.last_error`. Whether a route counts `maxTokens` against the completion
 * or the whole exchange is not visible from here, so the value now covers the
 * worst EXCHANGE — bounded input plus invited reply, priced as CJK on both
 * sides — and the assertion below derives that sum rather than trusting a
 * number typed here.
 *
 * 12000 was originally set against a worst exchange of 11940, computed when
 * `ROLLUP_TARGET_CHARS` was 900 and unenforced. Both halves of that sentence
 * have since changed, so the figure is restated rather than left to rot into a
 * number that no longer describes anything.
 *
 * The worst exchange is no longer the rollup's, and neither is the worst
 * reply. With `ROLLUP_TARGET_CHARS` enforced at 620 the rollup exchange is
 * 6000 of bounded input plus 6 × (60 + 620 + 30) = 4260 invited, i.e. 10260;
 * `extract` is 7000 of bounded input plus 5 × (120 + 800 + 60) = 4900 invited,
 * i.e. 11900. The assertions below take the max over the prompts rather than
 * naming one, so they keep pointing at whichever is worst without being told.
 *
 * 11900 against 12000 is a 100-character margin, and it is stated plainly
 * because it reads tighter than it is. Both sides are priced at ONE token per
 * character, i.e. as if every byte of a 7000-character transcript and every
 * byte of the reply were Chinese; the same text priced as English costs about a
 * quarter of that. The margin is therefore the slack remaining in an already
 * deliberately pessimistic worst case, not the slack in the typical one — and
 * `EXTRACT_TRANSCRIPT_CHARS` is the term that was solved against this cap
 * (see there), which is the direction of travel this file wants: the derived
 * value moves, the guardrail stays. 12000 itself stays for the reason it has
 * always had — it guards against a runaway reply, and lowering it to
 * re-manufacture headroom would risk a third round of the truncation bug for
 * jobs that are rare and whose real cost control is the input side.
 */
export const LLM_MAX_TOKENS = 12_000

/** Title length cap (fail loud beyond — propose validation). */
export const TITLE_MAX_CHARS = 200
/** Body length cap (fail loud beyond — propose validation). */
export const BODY_MAX_CHARS = 2_000

/**
 * What the extract prompt ASKS the model for. Deliberately tighter than the
 * hard caps above: an auto-distilled memory should be terser than what a human
 * may deliberately save, and asking for the hard limit invites output that
 * lands exactly on the truncation boundary.
 *
 * They live here, beside the caps they must stay below, because a target and
 * its ceiling are one decision. `prompts.ts` interpolates them rather than
 * restating the numbers, so the two cannot drift apart silently — and the
 * invariant (target ≤ cap) is checked once, below.
 */
export const EXTRACT_TITLE_TARGET_CHARS = 120
export const EXTRACT_BODY_TARGET_CHARS = 800
/**
 * Body length ASKED OF each scenario briefing (L2) — the number interpolated
 * into the rollup prompt by `prompts.ts`.
 *
 * ## What this constant is now, and what it stopped being
 *
 * It is no longer the enforced bound. The write path cuts to
 * `SCENARIO_MAX_TOKENS` (rendered tokens), not to this (characters), because
 * the container that spends the row prices tokens and a character limit cannot
 * see the two characters `renderEntry` adds per newline. The history below is
 * kept because it explains where 620 came from — but read it knowing that its
 * conclusion has changed roles:
 *
 * - THEN: this arithmetic DEFINED the ceiling, and the write path enforced the
 *   character count it produced.
 * - NOW: `SCENARIO_MAX_TOKENS` (188) is the ceiling and the write path enforces
 *   that. This value is a REQUEST — a model cannot count our tokens, so the
 *   prompt must ask in characters — and the satisfiability guard at the bottom
 *   of this file CERTIFIES that request: a body of this length, at the worst
 *   density we bill for, must price under the ceiling.
 *
 * That guard is this constant's only keeper; measured, removing it lets 640,
 * 700 and 900 all load silently. So the arithmetic below is still live, but it
 * now answers "is what we ask for satisfiable?" rather than "what is the
 * limit?".
 *
 * 620 is DERIVED, not chosen. The load-time guard at the bottom of this file
 * requires the L3 portrait plus `ROLLUP_MAX_SCENARIOS` blocks, priced through
 * the real `renderEntry`, to fit `INJECT_BODY_BUDGET_TOKENS`:
 *
 *     worstPersona + 6 x worstScenario <= 1300
 *
 * With bodies priced at their worst SHAPE as well as their worst length (see
 * `DERIVED_WORST_LINE_CHARS`), the portrait costs 171 tokens, leaving 1129 for
 * six blocks — which solves to a body ceiling of 639 characters. That figure
 * still holds under the token rule and is re-checked on every load: 639 prices
 * to 188 and passes, 640 prices to 189 and throws. At 900 the guard reports far
 * over budget, which is how the original defect was found, and it matches the
 * live store where half the blocks were dropped.
 *
 * The value sits at 620 rather than on the 639 boundary, and the reason has
 * outlived the mechanism that first produced it. It used to be "so the guard's
 * own assumption is not load-bearing": at 639 the design survived only bodies
 * carrying >= 30 characters PER NEWLINE, exactly the figure the guard assumes,
 * so the assumption had to be perfect. Under the token rule a denser body is
 * TRUNCATED rather than dropped, so the assumption is no longer load-bearing at
 * all — but the distance still buys the thing that replaced it: at 620 the
 * request prices to 183 of 188 and stays under the ceiling down to 22
 * characters per newline (45 breaks per 1000, against 33.75 for the densest row
 * on this machine and 83.75 for the densest DERIVED row), which is what keeps
 * truncation an exception rather than the daily path. Sitting on 639 would put
 * ordinary output on the boundary and spend 10 of every block's tokens on a
 * truncation mark. That margin costs 19 characters of briefing, about 3%.
 *
 * The unit is characters PER NEWLINE, not average line length: they differ by
 * one (a 270-char body with 8 breaks averages 30.0-char lines but 33.75 chars
 * per newline). Stating it the other way overstates the headroom by a line,
 * and this distinction already derailed two rounds of review.
 *
 * An earlier round set this to 650 against a guard that priced single-line
 * bodies. That figure did NOT survive pricing the newlines: it lands at 1317
 * against 1300. The number moved because the rule got stricter, which is the
 * intended direction of travel — the constant follows the invariant rather
 * than the invariant being trimmed to preserve the constant.
 *
 * Deliberately NOT solved by raising `INJECT_BODY_BUDGET_TOKENS`: that budget
 * is the packet the model reads on every single turn, and it is spec §4.2, not
 * a tuning knob. Nor by cutting `ROLLUP_MAX_SCENARIOS`, which buys length by
 * losing coverage — see that constant for why few-and-large is the design.
 */
export const ROLLUP_TARGET_CHARS = 620
/**
 * Body length asked of the L3 portrait. Short on purpose: it is injected in
 * EVERY repository, and its job is a disposition, not an inventory — the
 * atomic preferences remain recallable underneath it.
 */
export const PERSONA_TARGET_CHARS = 600
/** Personal memories fed into one persona judgement. */
export const PERSONA_SOURCE_LIMIT = 100

/**
 * The portrait's fixed title; it is a singleton, so the title is a label.
 *
 * It lives here rather than in `pipeline/rebuild.ts`, where it was written,
 * because the budget guard below has to price the portrait's rendered length —
 * and a guard that hardcodes "26 characters" while the writer holds the string
 * is two implementations of one fact. Renaming the portrait would then move
 * the real cost without moving the assertion, silently eroding the budget it
 * is supposed to protect.
 */
export const PERSONA_TITLE = 'How to work with this user'

/** Title length asked of a scenario — it is a name, not a sentence. */
export const ROLLUP_TITLE_TARGET_CHARS = 60
/**
 * How many scenarios one rebuild may produce. Injection shows the most
 * relevant one and prices the rest against the budget, so this bounds the
 * work, not the packet. Few and large beats many and thin: a scenario exists
 * to restore a working context, and a one-line scenario restores nothing.
 */
export const ROLLUP_MAX_SCENARIOS = 6

/* A target above its own truncation point would ask the model for text we
   would then cut. Cheap to assert at load; impossible to forget later. */
if (
  EXTRACT_TITLE_TARGET_CHARS > TITLE_MAX_CHARS ||
  EXTRACT_BODY_TARGET_CHARS > BODY_MAX_CHARS ||
  ROLLUP_TARGET_CHARS > BODY_MAX_CHARS ||
  ROLLUP_TITLE_TARGET_CHARS > TITLE_MAX_CHARS ||
  PERSONA_TARGET_CHARS > BODY_MAX_CHARS
) {
  throw new Error('strataloom: a prompt target exceeds the hard cap it must stay below')
}

/**
 * The worst rollup reply the prompt permits, in characters: every scenario at
 * its full title and body target, plus ~30 characters of JSON scaffolding per
 * block (`{"title":"…","body":"…"},`).
 *
 * A function rather than three copies of the expression. It was literally
 * three copies — twice in this file and once in `test/pipeline-e2e.test.mjs` —
 * which is the D7–D9 failure mode in miniature: the day someone re-tunes a
 * target, two of the three move. Exported so the test asserts the same
 * arithmetic the guards use instead of restating it.
 */
export const worstRollupReplyChars = (): number =>
  ROLLUP_MAX_SCENARIOS * (ROLLUP_TITLE_TARGET_CHARS + ROLLUP_TARGET_CHARS + 30)

/**
 * Fraction of a string's characters that may need JSON escaping.
 *
 * This is a COUNT rate, not a growth rate, and the distinction is the whole
 * reason it is a separate constant. `JSON.stringify` charges different prices
 * per escaped character — +1 for `"`, `\n`, `\t`, but **+5** for a control
 * character rendered as `\u001f` — so "how many characters escape" and "how
 * much longer the string gets" are two different questions, and only the first
 * is a property of the text. `worstEscapedString` applies the worst PRICE to
 * this rate; conflating them is how the previous round under-priced the reply
 * by a factor of five on the escaped portion.
 *
 * Measured across all 510 title/body strings in the eight live stores: 0.438%
 * of characters need escaping overall, the worst single string is 5.06% (a
 * 79-character title carrying 4 escapes), and **zero** are the +5 class. 6%
 * rounds the worst observed count UP, so the reply below is priced against text
 * that escapes more often than anything this project has stored AND at a price
 * no stored string has ever paid.
 *
 * It exists as a named constant for the same reason `DERIVED_WORST_LINE_CHARS`
 * does: it is a dimension of the worst case that the length limits cannot see,
 * and a guard blind to it certifies a reply the provider may still truncate.
 */
export const REPLY_WORST_ESCAPE_RATE = 0.06

/**
 * The worst extract reply the prompt permits, BUILT and then measured.
 *
 * The scaffolding is not a number typed here. An earlier round wrote it as a
 * flat `+ 60` per candidate with a comment conceding that 60 was an estimate
 * "not a measured maximum, since a title carrying escapes costs more than its
 * length" — and then parked `EXTRACT_TRANSCRIPT_CHARS` 100 characters below the
 * ceiling that estimate produced. Measured, the real figure is about 145 per
 * candidate, so five candidates overran that reserve by roughly 425: the
 * assumption was named as a risk and still never checked, which is precisely
 * the failure `ROLLUP_TARGET_CHARS` records one screen up.
 *
 * So this constructs the worst candidate the same way `worstShapedBody` does
 * for the packet guard — a title and body at their full targets, shaped with
 * escape-forcing characters at `REPLY_WORST_ESCAPE_RATE`, the longest `kind`
 * literal, and a generous `sourceSeqs` list — and asks `JSON.stringify` what it
 * costs. The guard then prices byte-for-byte what a reply would actually
 * occupy, rather than what someone counted by eye; every hand-count attempted
 * during this fix (60, 104, 136) was wrong, in both directions.
 *
 * `WORST_SOURCE_SEQS` is 10 because that is what the exchange inequality
 * SOLVES TO, and `pipeline/extract.ts: parseCandidates` now enforces it on the
 * reply — so it is a derived bound the writer keeps, not a bound assumed here
 * and left unchecked. Parameterising `worstExtractReplyChars` over the array
 * length and re-running `EXTRACT_TRANSCRIPT_CHARS + reply <= LLM_MAX_TOKENS`
 * puts the break at N=11: N=10 prices the exchange at 5300 + 6682 = 11982 (18
 * characters of margin), N=11 at 5300 + 6717 = 12017, over the cap by 17. So
 * 10 is the largest array this exchange can hold, and 11 is not a smaller
 * safety margin — it is a violated guard.
 *
 * It used to be a CHOSEN number, justified as "well clear" of a measured
 * maximum of 6 cited segments per candidate (167 memories with session
 * evidence: p50 2, p90 3, p99 5, max 6). That measurement is kept as reference
 * data but it does NOT derive this bound, in either direction: those excerpts
 * were written through a truncation that cut the JOINED string to
 * `EXTRACT_EVENT_EXCERPT_CHARS`, and 90.5% of them (218 of 241) came out at
 * exactly 400 characters — so "max 6" is a count of the segments that survived
 * the cut, a LOWER bound on what the model actually cited. An upper bound can
 * never be read off it. The prompt still sets no cap on the array, which is
 * precisely why the parse has to.
 *
 * `WORST_SEQ` is 999999, and the first version of this guard got it wrong in
 * the same way the `+ 60` did — by assuming instead of looking. It used 9999
 * with a comment calling four digits "the widest a realistic transcript
 * produces". The real store says otherwise: across 3312 L0 rows, 74.8% of seqs
 * are ALREADY wider than four digits (67.4% are five, 7.4% are six) and the
 * maximum is 126635; across 145 platform logs, 30 sessions exceed 9999 and the
 * largest seq is 148539. A seq is a session-lifetime counter, so it grows with
 * session length and four digits was never the shape of it.
 *
 * The escape rate is likewise priced at its WORST CLASS, not its most common
 * one. `JSON.stringify` charges +1 for `"`, `\n`, `\t`, but +5 for a `\u001f`
 * control character, and title/body are free model text. Today's stored strings
 * contain zero such characters, which is exactly the kind of "true right now"
 * fact this file refuses to build a bound on — so the constructed string uses
 * the +5 class at `REPLY_WORST_ESCAPE_RATE`, making the priced worst case about
 * five times the escaping any stored row exhibits.
 *
 * A function for the same reason its rollup sibling is one — it was written out
 * twice, here and in `test/pipeline-e2e.test.mjs`, and the exchange guard below
 * needs it a third time.
 */
export const WORST_SOURCE_SEQS = 10
const WORST_SEQ = 999_999

/**
 * A string of `chars` characters shaped to force the worst escaping there is.
 *
 * The escaped character is a control character, NOT a quote: `JSON.stringify`
 * renders it as `\u001f`, six characters for one, where a quote costs two. A
 * guard built on quotes would price the common case and under-price the worst
 * by 5x on the escaped portion — the same shape of error as pricing a body
 * without its newlines (see `DERIVED_WORST_LINE_CHARS`).
 */
const worstEscapedString = (chars: number): string => {
  const period = Math.max(2, Math.floor(1 / REPLY_WORST_ESCAPE_RATE))
  let out = ''
  for (let index = 0; index < chars; index++) {
    out += (index + 1) % period === 0 ? '\u001f' : 'x'
  }
  return out
}

export const worstExtractReplyChars = (): number => {
  const candidate = {
    title: worstEscapedString(EXTRACT_TITLE_TARGET_CHARS),
    body: worstEscapedString(EXTRACT_BODY_TARGET_CHARS),
    // The longest kind literal, taken from the enum rather than quoted, so a
    // new kind with a longer name moves this guard by itself.
    kind: [...MEMORY_KINDS].sort((a, b) => b.length - a.length)[0] ?? '',
    sourceSeqs: Array.from({ length: WORST_SOURCE_SEQS }, () => WORST_SEQ),
  }
  // +1 for the comma joining this candidate to the previous one.
  const perCandidate = JSON.stringify(candidate).length + 1
  return EXTRACT_MAX_CANDIDATES * perCandidate + JSON.stringify({ candidates: [] }).length
}

/* The cap must also survive a provider that counts `maxTokens` against the
   WHOLE exchange rather than the completion alone. Which of the two a route
   means is not something this plugin can see, and a live rollup finished as
   `max-tokens` with room to spare on the output side — so the honest budget is
   the worst input plus the worst reply, priced as CJK on both sides. Bounding
   the input is what makes that sum finite at all; before ROLLUP_TRANSCRIPT_CHARS
   existed, the rollup input grew with the overflow that triggered the job.

   The max runs over EVERY prompt whose input is bounded by a character
   constant, and `extract` was missing from it until now. That was a real hole
   in the coverage rather than an oversight about one number: the guard read as
   "the exchange fits", so `EXTRACT_TRANSCRIPT_CHARS` could be raised to any
   value at all and nothing here would have noticed — the only assertion that
   mentioned extract priced its REPLY alone. Adding the term is also what makes
   EXTRACT_TRANSCRIPT_CHARS a derived value instead of a number typed by hand —
   and it immediately earned its keep: the first value derived against an
   ESTIMATED reply (7000, from a hand-counted "+60 per candidate") is over the
   real ceiling by 442, which this guard now refuses at load.

   Two prompts stay outside, and the reason is stated rather than left to be
   discovered: `reconcile` and `persona` bound their inputs by ROW COUNT
   (RECONCILE_EXISTING_LIMIT, PERSONA_SOURCE_LIMIT) with each row bounded only
   by BODY_MAX_CHARS, so their worst case is a different and much larger
   product. Pricing them here would be a real tightening, not a restatement,
   and it belongs to whoever measures it — asserting an unmeasured bound would
   just move the arbitrary number rather than remove it. */
const worstExchangeChars = Math.max(
  ROLLUP_TRANSCRIPT_CHARS + worstRollupReplyChars(),
  EXTRACT_TRANSCRIPT_CHARS + worstExtractReplyChars(),
)
if (LLM_MAX_TOKENS < worstExchangeChars) {
  throw new Error(
    `strataloom: LLM_MAX_TOKENS (${LLM_MAX_TOKENS}) cannot hold the worst exchange ` +
      `(${worstExchangeChars} CJK tokens of prompt plus reply)`,
  )
}

/* The same rule one level up: the output cap must fit what the prompts invite.
   Priced on the worst reply each prompt permits, with JSON scaffolding.

   The character targets are a budget for CONTENT, and this store's content is
   largely Chinese, where a character costs about one token rather than the
   quarter `estimateTokens` assumes. So the worst case is priced at one token
   per character instead of `chars/4` with a doubling bolted on: that fudge
   read as headroom while still understating the real worst case by 2x, and it
   let a cap through that truncated the one rollup with a large Chinese input.
   Pricing the honest way makes the assertion mean what it says, and a future
   prompt that asks for more fails at load rather than as "not valid JSON" in
   production. The estimator keeps `chars/4` — it guards packet budgets, where
   over-estimating CJK would evict memories that would have fit. */
const worstReplyChars = Math.max(
  worstRollupReplyChars(),
  worstExtractReplyChars(),
  PERSONA_TARGET_CHARS + 60,
)
if (LLM_MAX_TOKENS < worstReplyChars) {
  throw new Error(
    `strataloom: LLM_MAX_TOKENS (${LLM_MAX_TOKENS}) is below what the prompts ask for; ` +
      'a capped reply arrives truncated and unparseable',
  )
}

/* The derived layer must FIT THE PACKET IT EXISTS TO PRODUCE.
   L2 and L3 are what injection shows once the raw set overflows, so a derived
   layer that overflows in turn has nowhere left to fall back to: the blocks
   are silently dropped and nobody decided which ones. Measured on a live
   store before this guard existed — six scenario blocks were built, three
   reached the packet, and the portrait had already spent part of the budget.

   Three deliberate choices, each of which someone will otherwise "fix":

   1. Priced through the REAL `renderEntry`, not a hand-written
      `9 + title + 2 + body`. The prefix is not a constant a reader can
      recover by eye: it depends on the row's `kind`, so L3's `- [preference] `
      is 15 characters where L2's `- [fact] ` is 9. Both hand-counts were got
      wrong twice while drafting this very guard. Calling the renderer means
      the guard prices byte-for-byte what `renderFramed` will emit — the same
      discipline D8 already applies to the runtime budget.
   2. The kinds are the ones the writer hardcodes in its INSERT statements
      (`pipeline/rebuild.ts`: 'fact' for LAYER.SCENARIO, 'preference' for
      LAYER.PERSONA), because the rendered prefix is what costs tokens.
   3. The unit is `chars/4` via `estimateTokens`, and that is INTENTIONALLY a
      different ruler from the two `LLM_MAX_TOKENS` guards above, which price
      CJK at one token per character. Do not "unify" them: the container is
      what picks the ruler. Up there the container is the PROVIDER's context
      window, measured by the provider's own tokenizer, so under-counting CJK
      truncates a reply. Down here the container is OURS, and `renderFramed`
      subtracts `estimateTokens(entry)` at runtime — pricing this guard any
      other way would assert something the runtime never checks. One container,
      one ruler.

   Only the DERIVED layer is guarded, and that asymmetry is the design, not an
   omission. L1 overflow is legal — it is precisely the condition that turns
   this layer on (`packetOverflows` in `pipeline/rebuild.ts`), and it is
   remediable, because overflowing is what summons the summary. Derived
   overflow has no such downstream. So `packetOverflows` and this assertion are
   two views of ONE container, not a duplicated rule: that one measures actual
   rows at runtime to decide whether to act, this one measures the worst
   permitted shape at load to decide whether the design can hold. Neither can
   answer the other's question, and merging them would delete one of the two. */
/**
 * The shortest line a derived body is priced against, in characters.
 *
 * `renderEntry` indents a body's own newlines (`\n` → `\n  `), so every line
 * break costs two characters the length limits never see. A guard that priced
 * `'x'.repeat(n)` — one synthetic line, zero newlines — would be blind to that
 * entire dimension, and the blindness is not academic. Measured across all
 * eight live stores, at the enforced targets:
 *
 *     newline density   packet (portrait + 6 blocks)
 *      0    per 1k ch     1247   OK
 *     11.94 per 1k ch     1271   OK   <- densest DERIVED row on this machine
 *     33    per 1k ch     1307   OVER BUDGET, and the old guard said green
 *     80    per 1k ch     1403   OVER BUDGET
 *
 * So the old guard certified a packet that a briefing written as a compact
 * bullet list would overflow — safe on today's data, wrong as a rule, and
 * silent about the difference. "The guard is green" was never allowed to mean
 * "this is safe" (ADR 0007, lesson 1); pricing the dimension is how the guard
 * earns the right to be read that way.
 *
 * 30 is derived from the data, not chosen for roundness, and its unit is
 * characters PER NEWLINE (not average line length — the two differ by one).
 * The densest single row across every live store is 29.63 newlines per 1000
 * characters (a 270-character note carrying 8 line breaks), i.e. one newline
 * every 33.75 characters; 30 rounds that DOWN, so the guard prices a body
 * denser than anything this project has stored. Measured against the rows this
 * constant actually serves — DERIVED rows only — the densest is 83.75
 * characters per newline, so 30 is 2.8x stricter there.
 *
 * The alternative (b) — leave the guard single-line and merely DOCUMENT the
 * boundary in a comment — was rejected: it leaves a known false-green in the
 * one mechanism whose whole job is to fail loudly, and the comment is read
 * only by someone who already suspects the problem.
 *
 * ## Its role changed, and the exposure it used to describe is gone
 *
 * This constant no longer COMPUTES a ceiling. `PERSONA_MAX_TOKENS` and
 * `SCENARIO_MAX_TOKENS` are the ceilings, the write path enforces them in
 * rendered tokens, and a body denser than priced here is now TRUNCATED to fit
 * rather than being over budget. What this shape does instead is certify, in
 * the satisfiability guard below, that the length we ASK the model for lands
 * under those ceilings at a density we are willing to bill for — i.e. that
 * truncation stays the exception rather than the daily path.
 *
 * The paragraph that used to sit here described the residual exposure and got
 * its causality BACKWARDS. It claimed that under a denser body "what gives
 * first is the PORTRAIT, not the scenario blocks", so the L2 layer the fix
 * protects still reached the packet. Both halves were false, and measurement
 * says so in both directions (this is corrected in full in ADR 0007's
 * 「残余敞口」 section, where the original wording is kept):
 *
 *     portrait at 600 chars / 21 newlines  -> 172 tok vs a 171 cap: the
 *         portrait was not "given up" gracefully, it was DROPPED WHOLE, since
 *         `withinBudget` skips rather than trims. Zero rows, every repository.
 *     with a compliant 163-tok portrait and 620-char blocks, varying block
 *         density: 1 newline per 30 -> L2 6/6; per 10 -> 5/6; per 3 -> 4/6;
 *         per 2 -> 3/6 — the portrait survived every time and the "protected"
 *         L2 layer was what degraded.
 *
 * So neither layer was shielded by the other; each simply failed in its own
 * direction, and the claim that one absorbed the damage was an assumption that
 * was never measured. Enforcing the write path in rendered tokens removes the
 * exposure rather than reassigning it: a dense body is cut to its ceiling and
 * arrives marked, at whatever density.
 */
export const DERIVED_WORST_LINE_CHARS = 30

/**
 * A synthetic body of `chars` characters shaped like the worst thing the
 * renderer could be handed: lines of `DERIVED_WORST_LINE_CHARS`, every break a
 * real `\n` that `renderEntry` will indent. Built rather than described, so
 * the guard prices the same string operation production performs.
 */
export const worstShapedBody = (chars: number): string => {
  let body = ''
  for (let index = 0; index < chars; index++) {
    body += (index + 1) % DERIVED_WORST_LINE_CHARS === 0 ? '\n' : 'x'
  }
  return body
}

const worstDerivedRowTokens = (kind: string, titleChars: number, bodyChars: number): number =>
  estimateTokens(
    renderEntry(
      { id: '', kind, title: 'x'.repeat(titleChars), body: worstShapedBody(bodyChars) },
      false,
    ),
  )

/* ── The derived layer's two ceilings, in the unit its container spends ──────

   These two numbers are the whole fix. Every derived row is bounded HERE, in
   RENDERED TOKENS, because rendered tokens are what `renderFramed` subtracts
   from `INJECT_BODY_BUDGET_TOKENS` at runtime. The write path used to bound
   CHARACTERS instead (`slice(0, ROLLUP_TARGET_CHARS)`), and characters are not
   the container's unit: `renderEntry` indents every `\n` to `\n␣␣`, so a body
   costs 2 characters per line break that no character limit can see.

   That mismatch was not a rounding error, it silently deleted content. A
   portrait at exactly `PERSONA_TARGET_CHARS` (600) — fully compliant, passed
   by the write path without a cut — renders at 172 tokens once it carries 21
   line breaks, against a 171-token cap. `withinBudget` SKIPS what it cannot
   afford rather than trimming it, so the portrait was not shortened, it was
   dropped whole: zero rows injected, in every repository. The live portrait on
   this machine renders at 163 tokens, i.e. it was running on 8 tokens of
   accidental headroom.

   Both ends of the pipeline now measure in the same unit, with the same code
   (`truncatedToBudget`, the renderer's own). ADR 0009's rule stated the other
   way round: the outermost ruler is the only one that decides, so the write
   path is not allowed a private one. */
/**
 * The ceiling on ONE rendered L3 portrait.
 *
 * DERIVED, not chosen: it is the portrait's share in the inequality below,
 * priced through the real `renderEntry` at `PERSONA_TARGET_CHARS` characters
 * shaped at `DERIVED_WORST_LINE_CHARS` — 171. Written as a literal rather than
 * left as that call so the write path has a fixed contract to cut against: a
 * budget recomputed per call is a budget that moves under stored rows.
 *
 * ## What actually holds this literal to 171, in each direction
 *
 * The load-time guards below do NOT pin it. They are inequalities, so each
 * binds on one side only, and it is worth being exact about which:
 *
 * - TOO LOW is caught by the satisfiability guard (`requested > ceiling`): the
 *   requested portrait would no longer fit its own ceiling. Measured: 170
 *   throws there.
 * - TOO HIGH is caught by the capacity guard, but only once the packet
 *   overflows: it admits any `P <= 1300 - 6 * 188 = 172`. Measured: 173 throws,
 *   174/175/179/180 throw.
 *
 * So exactly ONE wrong value — **172** — satisfies both guards, and nothing in
 * this file would report it. What reports it is the equality asserted in
 * `test/pipeline-e2e.test.mjs`:
 *
 *     assert.equal(worstPersonaTokens(), priced(worstShapedBody(PERSONA_TARGET_CHARS)))
 *
 * Measured: setting this to 172 turns 2 of 231 tests red. That assertion is
 * the only thing tying this constant to the text it claims to price, which is
 * why it is an equality and not a bound.
 *
 * Do NOT "fix" this by tightening the satisfiability guard to `!==`. It was
 * tried and it breaks the shipped build immediately: the L2 request is priced
 * at 183 against a ceiling of 188, and that gap is DELIBERATE — it is what
 * keeps truncation an exception rather than the daily path (see
 * `SCENARIO_MAX_TOKENS`). An equality guard reads that intended distance as an
 * error. The guard stays `>`; the equality belongs in the test, where it can
 * be stated about the portrait alone.
 */
export const PERSONA_MAX_TOKENS = 171
/**
 * The ceiling on ONE rendered L2 scenario block.
 *
 * Solved, not picked: it is the largest integer satisfying the inequality this
 * file throws on below,
 *
 *     PERSONA_MAX_TOKENS + ROLLUP_MAX_SCENARIOS x SCENARIO_MAX_TOKENS
 *         <= INJECT_BODY_BUDGET_TOKENS
 *     171 + 6 x 188 = 1299 <= 1300
 *
 * so 188 = floor((1300 - 171) / 6).
 *
 * ## The 1 token of slack is the answer, not a near miss
 *
 * 189 gives 171 + 6 x 189 = 1305, which is 5 over: the step size is
 * `ROLLUP_MAX_SCENARIOS`, so the last admissible value necessarily sits within
 * 6 tokens of the budget and 188 is the largest one. That 1 token is therefore
 * the arithmetic being tight, NOT a margin someone forgot to leave, and it must
 * not be "made safer" by dropping to 187: that donates 6 tokens of briefing to
 * nothing, because nothing else spends from this budget.
 *
 * The safety that a margin would buy is bought instead by the satisfiability
 * guard below, which is the right place for it — it asserts that ordinary
 * output lands BELOW this ceiling (620 chars at 1 newline per 30 costs 183,
 * and still only 187 at 1 per 22), so truncation is the exception path rather
 * than the daily one. Slack in the ceiling protects against nothing; distance
 * between the request and the ceiling protects against everything this has
 * historically got wrong.
 */
export const SCENARIO_MAX_TOKENS = 188

/**
 * The worst RENDERED cost of the L3 portrait — and the number two different
 * mechanisms are required to agree on.
 *
 * It is a function, exported, and called from both places rather than written
 * down anywhere, because it is one rule with two execution points:
 *
 * - the load-time guard below spends it as the portrait's share of the packet,
 *   which is what makes `SCENARIO_MAX_TOKENS` solvable at all;
 * - `recall/inject.ts` spends it at runtime as the CAP on what the personal
 *   store may contribute, so the L1 fallback that stands in for a missing
 *   portrait costs no more than the portrait it replaces.
 *
 * Two containers, one ruler. That distinction is the `constants.ts` precedent
 * spelled out for `packetOverflows`: the same rule executed on two different
 * containers is not a duplicated rule, whereas the same number typed twice is.
 * If these ever disagree, the guard certifies a packet the runtime does not
 * build — which is exactly the failure ADR 0007 records.
 *
 * It now RETURNS the ceiling rather than re-pricing a synthetic shape, because
 * the write path enforces that ceiling directly: what the runtime caps and what
 * the writer produces are the same quantity, so they must be the same value and
 * not two computations that agree today. The shape-derived figure did not
 * disappear — the satisfiability guard below still computes it and requires it
 * to fit, which is what stops this constant from drifting away from the text it
 * is supposed to describe.
 */
export const worstPersonaTokens = (): number => PERSONA_MAX_TOKENS

/** The worst rendered cost of ONE L2 scenario block — the ceiling its writer cuts to. */
export const worstScenarioTokens = (): number => SCENARIO_MAX_TOKENS

/**
 * GUARD 1 (capacity). THE invariant. One inequality, and it yields both numbers
 * this design needs: the per-block ceiling the write path enforces, and the
 * personal-side cap the read path applies.
 *
 *     worstPersona + ROLLUP_MAX_SCENARIOS x worstScenario <= INJECT_BODY_BUDGET_TOKENS
 *
 * The portrait is injected in EVERY repository, so it is spent first and the
 * scenarios compete for what is left.
 */
const worstDerivedPacketTokens = (): number =>
  worstPersonaTokens() + ROLLUP_MAX_SCENARIOS * worstScenarioTokens()
const worstDerivedTokens = worstDerivedPacketTokens()
if (worstDerivedTokens > INJECT_BODY_BUDGET_TOKENS) {
  throw new Error(
    `strataloom: the derived layer cannot fit its own packet — worst case is ` +
      `${worstDerivedTokens} tokens (L3 portrait + ${ROLLUP_MAX_SCENARIOS} L2 blocks) ` +
      `against INJECT_BODY_BUDGET_TOKENS (${INJECT_BODY_BUDGET_TOKENS}); ` +
      `lower PERSONA_MAX_TOKENS or SCENARIO_MAX_TOKENS`,
  )
}

/**
 * GUARD 2 (satisfiability). The character targets we ASK the model for must fit
 * the token ceilings we then cut them to, at the worst density we are willing
 * to price.
 *
 * Guard 1 proves the ceilings fit the packet. It says nothing about whether the
 * REQUEST fits the ceilings, and without that second question the two halves of
 * this design come apart in a way nothing would report:
 *
 * - `prompts.ts` keeps asking the model for a character count (correctly — a
 *   model cannot count our tokens), so `ROLLUP_TARGET_CHARS` remains a real
 *   input to a real request while no longer being the thing enforced. Before
 *   this guard existed in this form, `ROLLUP_TARGET_CHARS` was bounded by the
 *   capacity guard; move the enforcement to tokens and that constant becomes
 *   UNGUARDED. This guard is now its ONLY keeper — measured against today's
 *   code by deleting this block and re-loading the module:
 *
 *       640 -> no throw     700 -> no throw     900 -> no throw
 *
 *   including 900, the historical value the live store was measured at. An
 *   earlier draft of this comment said 700 and 900 would still be caught by
 *   `RECALL_FOREIGN_BUDGET_TOKENS` "for an unrelated reason". That was true of
 *   the naive prototype and is FALSE here: guard 3 below now prices the row as
 *   the writer would CUT it, so it no longer varies with this constant at all,
 *   and the incidental catch is gone with it. Nothing else in this file reads
 *   `ROLLUP_TARGET_CHARS` for a bound.
 * - Truncation would silently become the NORMAL path. `TRUNCATION_MARK` costs
 *   10 tokens of the 188 it is cut into, so a target that routinely overshoots
 *   spends real briefing on a marker announcing that briefing was lost, on
 *   every block, forever. The mark is meant to be seen rarely enough to mean
 *   something.
 *
 * So this asserts the request is SATISFIABLE: a worst-shaped body of the
 * requested length is priced through the real `renderEntry` and must land under
 * the ceiling. It binds the character target and the rendered shape at once,
 * and it is the reason `DERIVED_WORST_LINE_CHARS` and `worstShapedBody` remain
 * — their job changed from computing the ceiling to certifying the request.
 *
 * Measured at the shipped values: 620 chars at 1 newline per 30 costs 183 of
 * 188 and at 1 per 22 costs 187, while 640@1/30 costs 189 and 620@1/10 costs
 * 204 — both fire. The portrait is exact rather than slack (600@1/30 = 171 of
 * 171) because `PERSONA_MAX_TOKENS` is defined AS that price; a portrait denser
 * than `DERIVED_WORST_LINE_CHARS` is now truncated to fit instead of dropped
 * whole, which is the defect this round repaired.
 */
const satisfiability: readonly (readonly [string, string, number, number, string])[] = [
  ['L2 scenario', 'fact', ROLLUP_TITLE_TARGET_CHARS, ROLLUP_TARGET_CHARS, 'ROLLUP_TARGET_CHARS'],
  ['L3 portrait', 'preference', PERSONA_TITLE.length, PERSONA_TARGET_CHARS, 'PERSONA_TARGET_CHARS'],
]
for (const [label, kind, titleChars, bodyChars, targetName] of satisfiability) {
  const ceiling = kind === 'fact' ? SCENARIO_MAX_TOKENS : PERSONA_MAX_TOKENS
  const requested = worstDerivedRowTokens(kind, titleChars, bodyChars)
  if (requested > ceiling) {
    throw new Error(
      `strataloom: the derived layer cannot fit its own packet — the ${label} target ` +
        `${targetName} (${bodyChars} chars) prices at ${requested} tokens at the worst shape ` +
        `we bill for (one newline per ${DERIVED_WORST_LINE_CHARS} chars), above its ceiling ` +
        `of ${ceiling}; every block would be truncated as a matter of course, so lower ` +
        `${targetName} or re-solve the ceiling against INJECT_BODY_BUDGET_TOKENS ` +
        `(${INJECT_BODY_BUDGET_TOKENS})`,
    )
  }
}
/**
 * GUARD 3 (lower bound). The FLOOR on the per-member budget: the dearest L2
 * scenario row the write path can legally store, rendered WITH its id (recall
 * renders `withId=true`, and the id is 36 characters the injection path never
 * pays). A per-member budget below this would admit nothing at all from a
 * member whose store holds only scenario blocks — a feature that is on,
 * approved, and silently empty.
 *
 * ## Why the worst row had to be re-solved
 *
 * It used to be "`worstShapedBody(ROLLUP_TARGET_CHARS)`" — the worst row a
 * CHARACTER limit admits. The write path no longer enforces characters, so that
 * shape stopped being the boundary of what can be stored, and the question
 * changed to: among all bodies the injection cap admits (<= 188 rendered
 * tokens), which is dearest on the RECALL path?
 *
 * The two paths price the same body differently, which is what makes this a
 * real question rather than a rescaling. Injection renders
 * `- [fact] {title}: {body}` (11 chars of shell), recall adds the id and the
 * `(from …)` label at `SOURCE_LABEL_MAX_CHARS` (125 chars of shell). Both pay
 * +2 per newline. So the adversary maximises the RECALL length subject to the
 * INJECT length fitting — and because the two differ only by a constant shell,
 * the answer is the body that SATURATES the inject cap with the most
 * newline-inflated content. Solved by exhaustive search over title length,
 * body length and newline count: a title of 0 and a body of 247 newlines,
 * inject 752 chars = 188 tokens, recall 866 chars = **217 tokens**.
 *
 * 217 against `RECALL_FOREIGN_BUDGET_TOKENS` = 220 leaves **3 tokens**, down
 * from 8 under the old character-bounded shape (which priced 212). That figure
 * is written down because this budget has twice been pushed back by a change to
 * the RENDERED SHAPE rather than to any number here — adding the id, then
 * adding the `(from …)` label — and 3 tokens is roughly one such change of
 * headroom. Anything that lengthens `renderEntry`'s shell, or raises
 * `SCENARIO_MAX_TOKENS`, spends it. This guard throws rather than warns, so the
 * next such change surfaces at load; the note exists so the person reading the
 * throw knows the margin was 3 and not a comfortable unknown.
 *
 * It does not price a single-line synthetic body. `renderEntry` indents a
 * body's own newlines (`\n` → `\n␣␣`, +2 chars each), so `'x'.repeat(n)` is
 * blind to a whole dimension of the cost — the precise false-green ADR 0007
 * records, where a guard reported OK at a newline density that overflowed.
 * The body is built by CUTTING an over-long body with the production
 * `truncatedToBudget` at the production ceiling, so the guard prices a row the
 * writer can actually emit rather than a shape assumed to bound it.
 *
 * The CEILING — the one that bounds `GROUP_MAX_MEMBERS` — is deliberately NOT
 * here. It has to price a rendered packet, which means calling `renderFramed`,
 * which lives in `recall/inject.ts` and imports this module. So it lives in
 * `tools.ts`, next to the render call it is about to make. Putting it here
 * would close the `constants → inject → constants` cycle that `render.ts`
 * exists to keep open (see that module's header).
 *
 * Neither guard asserts against `INJECT_BODY_BUDGET_TOKENS`. Group content
 * NEVER reaches the injection packet (that path is untouched by design — three
 * merged libraries measure 4104 tokens against a 1300 budget, 3.16x, and the
 * derived-layer invariant runs on 1 token of slack, not the 31 ADR 0007
 * recorded: the ceilings are now solved in tokens, so the slack is the
 * remainder of `floor((1300 - 171) / 6)` rather than a margin left over from a
 * character target). Recall is a tool result: a different container, so a
 * different ruler.
 */
const worstStorableScenarioBody = ((): string => {
  // Over-long on purpose, then CUT by the production truncator at the
  // production ceiling: whatever the writer would do to an oversized block is
  // what this guard prices. Shaped rather than flat so the cut is exercised on
  // a body carrying the newlines `renderEntry` bills for.
  const oversized = worstShapedBody(ROLLUP_TARGET_CHARS * 4)
  const cut = truncatedToBudget(
    { id: '', kind: 'fact', title: 'x'.repeat(ROLLUP_TITLE_TARGET_CHARS), body: oversized },
    SCENARIO_MAX_TOKENS,
    false,
  )
  // The writer handles this case too (see `parseScenarios`); here it would mean
  // the ceiling cannot hold even a marked empty body, so no scenario row could
  // ever be stored and every number below would be vacuous.
  if (cut === undefined) {
    throw new Error(
      `strataloom: SCENARIO_MAX_TOKENS (${SCENARIO_MAX_TOKENS}) is too small to store any ` +
        'scenario body at all — even a fully truncated one does not fit its own mark',
    )
  }
  return cut.body
})()
const worstForeignRowTokens = estimateTokens(
  renderEntry(
    {
      // A real UUID's width, not a placeholder: the id is rendered, so it costs.
      id: '123e4567-e89b-12d3-a456-426614174000',
      kind: 'fact',
      title: 'x'.repeat(ROLLUP_TITLE_TARGET_CHARS),
      body: worstStorableScenarioBody,
      // A foreign row is the ONLY row that renders a `(from …)` label, and the
      // label is what makes the packet honest about whose memory it shows. It
      // is priced at the renderer's own ceiling (`SOURCE_LABEL_MAX_CHARS` —
      // which is why that cap exists at all, a declaration being hand-written
      // and otherwise unbounded), never at the length of a real source string:
      // pricing today's members would repeat the "existing data mistaken for
      // possible data" error this constant's own history records above.
      source: 'x'.repeat(SOURCE_LABEL_MAX_CHARS),
    },
    true,
  ),
)
if (RECALL_FOREIGN_BUDGET_TOKENS < worstForeignRowTokens) {
  throw new Error(
    `strataloom: RECALL_FOREIGN_BUDGET_TOKENS (${RECALL_FOREIGN_BUDGET_TOKENS}) cannot admit ` +
      `even one worst-shaped foreign row (${worstForeignRowTokens} tokens rendered with its id); ` +
      'an approved group would return nothing from such a member',
  )
}
/**
 * The worst-case ENTRY the packet guard fills its container with.
 *
 * Not the worst-shaped row above: that row maximises TOKENS, and the container
 * this must not overflow is denominated in CHARACTERS. Those pick opposite
 * adversaries. `estimateTokens` is `ceil(len / 4)`, so an entry costing `c`
 * tokens spans at most `4c` characters, and the bound is TIGHT — this exact
 * 16-character entry costs 4 tokens, the cheapest any entry can cost. Filling a
 * budget with these therefore produces the most characters a budget can ever
 * buy, and a guard that passes on them passes on everything.
 *
 * Exported because the guard that spends it lives in `tools.ts` (see above),
 * while the shape belongs beside the pricing rules it is built from.
 */
export const worstPacketFillEntry = (): { id: string; kind: string; title: string; body: string } => {
  const shell = renderEntry({ id: '', kind: '', title: '', body: '' }, true).length
  return { id: '', kind: '', title: 'x'.repeat(16 - shell), body: '' }
}
/** The worst rendered cost of one foreign row, exported so tests assert it rather than restate it. */
export const worstForeignRowCost = (): number => worstForeignRowTokens

