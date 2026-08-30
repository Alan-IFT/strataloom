/**
 * All runtime tuning constants in one place (spec §5.1: constants live
 * centrally, are NOT settings — they are P1-calibration parameters, not
 * design constants).
 * @module @strataloom/dsh-memory/constants
 */
import { estimateTokens, renderEntry } from './recall/render.ts'
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

/** FTS candidate cap for memory_recall (spec §4.3). */
/** Near-duplicate candidates offered back when saving. */
export const SIMILAR_LIMIT = 5

export const RECALL_CANDIDATE_LIMIT = 50
/** Rendered recall result budget (spec §4.3). */
export const RECALL_RESULT_BUDGET_TOKENS = 500

/**
 * Rows `/memory` lists per scope. Generous: the point of that command is
 * completeness, so the cap is a guard against flooding a chat with an enormous
 * store, not an editorial filter.
 */
export const LIST_LIMIT = 200

/**
 * Rows returned by the L0 drill-down mode of memory_recall (`sourceOf`).
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
/** Evidence excerpts are dropped after this long; refs are kept forever. */
export const EXCERPT_COMPACT_MS = 30 * 86_400_000
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

/** L0 conversation retention: raw turns outlive the jobs that read them,
 * but not forever — rows a live memory still cites are exempt. */
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
 * Body length asked of — and, since this fix, ENFORCED on — each scenario
 * briefing (L2). See `parseScenarios`: the write path truncates to this, so
 * the number below is a property of the data, not a hope about the model.
 *
 * 620 is DERIVED, not chosen. The load-time guard at the bottom of this file
 * requires the L3 portrait plus `ROLLUP_MAX_SCENARIOS` blocks, priced through
 * the real `renderEntry`, to fit `INJECT_BODY_BUDGET_TOKENS`:
 *
 *     worstPersona + 6 x worstScenario <= 1300
 *
 * With bodies priced at their worst SHAPE as well as their worst length (see
 * `DERIVED_WORST_LINE_CHARS`), the portrait costs 171 tokens, leaving 1129 for
 * six blocks — which solves to a body ceiling of 639 characters. At 900 the
 * guard reports far over 1300, which is how the defect was found, and it
 * matches the live store where half the blocks were dropped.
 *
 * The value sits at 620 rather than on the 639 ceiling so that the guard's own
 * remaining assumption is not load-bearing. At 639 the design survives only
 * bodies carrying >= 30 characters PER NEWLINE — exactly the figure the guard
 * assumes, leaving 1 token of slack, so the assumption would have to be
 * perfect. At 620 it survives down to 22 characters per newline (45 breaks per
 * 1000, against 33.75 for the densest row on this machine and 83.75 for the
 * densest DERIVED row) and keeps 31 tokens of slack. That margin costs 19
 * characters of briefing, about 3%.
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
 * `WORST_SOURCE_SEQS` is 10 against a measured maximum of 6 cited segments per
 * candidate (167 memories with session evidence: p50 2, p90 3, p99 5, max 6);
 * the prompt sets no cap on the array, so the bound has to be chosen rather
 * than derived, and it is chosen well clear of the data.
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
const WORST_SOURCE_SEQS = 10
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
 * The remaining exposure is stated rather than hidden: a derived body under 22
 * characters per newline — ASCII art, or a one-word-per-line list — still
 * costs more than this prices. What gives first is the PORTRAIT, not the
 * scenario blocks: the personal cap is spent before the repo rows, and
 * `withinBudget` skips a row whole. So the layer this fix exists to protect
 * still reaches the packet; the personal side degrades instead. That shape is
 * not what the rollup prompt asks for, and pricing for it would cost real
 * briefing length for a case no store exhibits.
 *
 * The alternative (b) — leave the guard single-line and merely DOCUMENT the
 * boundary in a comment — was rejected: it leaves a known false-green in the
 * one mechanism whose whole job is to fail loudly, and the comment is read
 * only by someone who already suspects the problem.
 */
export const DERIVED_WORST_LINE_CHARS = 30

/**
 * A synthetic body of `chars` characters shaped like the worst thing the
 * renderer could be handed: lines of `DERIVED_WORST_LINE_CHARS`, every break a
 * real `\n` that `renderEntry` will indent. Built rather than described, so
 * the guard prices the same string operation production performs.
 */
const worstShapedBody = (chars: number): string => {
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

/**
 * The worst RENDERED cost of the L3 portrait — and the number two different
 * mechanisms are required to agree on.
 *
 * It is a function, exported, and called from both places rather than written
 * down anywhere, because it is one rule with two execution points:
 *
 * - the load-time guard below spends it as the portrait's share of the packet,
 *   which is what makes `ROLLUP_TARGET_CHARS` solvable at all;
 * - `recall/inject.ts` spends it at runtime as the CAP on what the personal
 *   store may contribute, so the L1 fallback that stands in for a missing
 *   portrait costs no more than the portrait it replaces.
 *
 * Two containers, one ruler. That distinction is the `constants.ts` precedent
 * spelled out for `packetOverflows`: the same rule executed on two different
 * containers is not a duplicated rule, whereas the same number typed twice is.
 * If these ever disagree, the guard certifies a packet the runtime does not
 * build — which is exactly the failure ADR 0007 records.
 */
export const worstPersonaTokens = (): number =>
  worstDerivedRowTokens('preference', PERSONA_TITLE.length, PERSONA_TARGET_CHARS)

/** The worst rendered cost of ONE L2 scenario block, priced the same way. */
export const worstScenarioTokens = (): number =>
  worstDerivedRowTokens('fact', ROLLUP_TITLE_TARGET_CHARS, ROLLUP_TARGET_CHARS)

/**
 * THE invariant. One inequality, and it yields both numbers this design needs:
 * the per-block ceiling the write path enforces, and the personal-side cap the
 * read path applies.
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
      `lower ROLLUP_TARGET_CHARS or PERSONA_TARGET_CHARS`,
  )
}

