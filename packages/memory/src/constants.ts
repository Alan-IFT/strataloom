/**
 * All runtime tuning constants in one place (spec §5.1: constants live
 * centrally, are NOT settings — they are P1-calibration parameters, not
 * design constants).
 * @module @strataloom/dsh-memory/constants
 */
import { estimateTokens, renderEntry } from './recall/render.ts'

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

/** Turns returned by the L0 drill-down mode of memory_recall. */
export const SOURCE_TURN_LIMIT = 20

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
/** Per-event excerpt cap in the extract transcript. */
export const EXTRACT_EVENT_EXCERPT_CHARS = 400
/** Total transcript cap handed to the extract prompt. */
export const EXTRACT_TRANSCRIPT_CHARS = 6_000
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
 * number that no longer describes anything: with the target enforced at 620,
 * the worst exchange is 6000 characters of bounded input plus 6 × (60 + 620 +
 * 30) = 4260 of invited reply, i.e. 10260 CJK tokens — 1740 below the cap.
 *
 * So 12000 is now comfortable rather than marginal, and it stays: the value
 * was always meant to be a guardrail against a runaway reply, not a tight
 * budget, and lowering it to re-tighten the margin would buy nothing (these
 * jobs are rare, and the real cost control is the input side) while risking a
 * third round of the same truncation bug. Note also that the worst reply is no
 * longer the rollup's: at 620 the rollup invites 4260 characters, while
 * `extract` invites 5 × (120 + 800 + 60) = 4900. The assertion below already
 * takes the max over all three prompts, so it kept pointing at the real worst
 * case without being told which one that is.
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

/* The cap must also survive a provider that counts `maxTokens` against the
   WHOLE exchange rather than the completion alone. Which of the two a route
   means is not something this plugin can see, and a live rollup finished as
   `max-tokens` with room to spare on the output side — so the honest budget is
   the worst input plus the worst reply, priced as CJK on both sides. Bounding
   the input (ROLLUP_TRANSCRIPT_CHARS) is what makes that sum finite at all;
   before it, the input grew with the overflow that triggered the job.
*/
const worstExchangeChars = ROLLUP_TRANSCRIPT_CHARS + worstRollupReplyChars()
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
  EXTRACT_MAX_CANDIDATES * (EXTRACT_TITLE_TARGET_CHARS + EXTRACT_BODY_TARGET_CHARS + 60),
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

