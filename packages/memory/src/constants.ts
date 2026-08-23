/**
 * All runtime tuning constants in one place (spec §5.1: constants live
 * centrally, are NOT settings — they are P1-calibration parameters, not
 * design constants).
 * @module @strataloom/dsh-memory/constants
 */

/** SQLite `application_id`: 'STLM'. */
export const APPLICATION_ID = 0x53_54_4c_4d

/**
 * Current schema version (v1 = P0 core, v2 = P1 jobs/usage/superseded_by,
 * v3 = L0 + global store, v4 = decay/derived, v5 = derived invalidation as a
 * data property rather than a write-path responsibility).
 */
export const TARGET_USER_VERSION = 5

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

/** Decay runs at most once per this interval, per store. */
export const DECAY_INTERVAL_MS = 86_400_000

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
/** Output token cap for pipeline LLM calls. */
export const LLM_MAX_TOKENS = 1_000

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
/** What the rollup prompt asks for; it replaces the whole injectable set. */
export const ROLLUP_TARGET_CHARS = 900

/* A target above its own truncation point would ask the model for text we
   would then cut. Cheap to assert at load; impossible to forget later. */
if (
  EXTRACT_TITLE_TARGET_CHARS > TITLE_MAX_CHARS ||
  EXTRACT_BODY_TARGET_CHARS > BODY_MAX_CHARS ||
  ROLLUP_TARGET_CHARS > BODY_MAX_CHARS
) {
  throw new Error('strataloom: a prompt target exceeds the hard cap it must stay below')
}

/**
 * Token estimation is chars/4 everywhere (spec §4.3: budgets are truncation
 * guardrails, not billing — a tokenizer dependency buys no guardrail accuracy).
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
