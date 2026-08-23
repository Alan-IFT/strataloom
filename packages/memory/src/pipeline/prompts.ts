/**
 * Pipeline prompt templates, versioned (spec §1: prompts.ts 带版本号).
 * The version rides every job payload so a replayed job renders the prompt
 * it was enqueued for.
 * @module @strataloom/dsh-memory/pipeline/prompts
 */
import {
  EXTRACT_BODY_TARGET_CHARS,
  EXTRACT_TITLE_TARGET_CHARS,
  ROLLUP_MAX_SCENARIOS,
  ROLLUP_TARGET_CHARS,
  ROLLUP_TITLE_TARGET_CHARS,
  PERSONA_TARGET_CHARS,
} from '../constants.ts'
import { kindGuidance, MEMORY_KINDS } from '../types.ts'

/** Bumped whenever a template's semantics change. */
export const PROMPT_VERSION = 1

/** Current job payload schema version. */
export const PAYLOAD_VERSION = 1

/**
 * Extract: the model returns candidate content plus the source event seqs it
 * drew from. It never assigns provenance/visibility — the Service maps event
 * categories to provenance itself (D1: the model must not declare identity
 * facts).
 */
export const extractSystemPrompt = (): string =>
  `You distill durable, re-usable memories from one agent-session transcript.

Return STRICT JSON: {"candidates":[{"title":string,"body":string,"kind":${MEMORY_KINDS.map(
    (kind) => `"${kind}"`,
  ).join('|')},"sourceSeqs":number[]}]}

Rules:
- at most 5 candidates; return {"candidates":[]} when nothing is durable;
- kind: ${kindGuidance()};
- a candidate must be useful BEYOND this session — no task-progress notes, no
  one-off values, no secrets/credentials/tokens (omit them entirely);
- title: one imperative line ≤${EXTRACT_TITLE_TARGET_CHARS} chars; body: ≤${EXTRACT_BODY_TARGET_CHARS} chars, self-contained;
- sourceSeqs: the transcript event seq numbers the candidate came from
  (copy the seq labels verbatim; they select trust downstream);
- output the JSON object only — no markdown fence, no commentary.`

/**
 * Reconcile: dedupe/conflict/absorb one extract batch against existing
 * active memories (spec §3.4). The model decides per candidate:
 * activate / drop / supersede an existing id.
 */
export const reconcileSystemPrompt = (): string =>
  `You reconcile candidate memories against existing active memories of the same repository.

Return STRICT JSON: {"decisions":[{"candidateIndex":number,"action":"activate"|"drop"|"supersede","supersedes"?:string}]}

Rules (by kind):
- exact/near duplicates of an existing memory => "drop";
- fact conflicting with an older fact and carrying fresher evidence =>
  "supersede" with the existing memory id in "supersedes";
- procedure that replaces an older procedure => "supersede" (versioning);
- preference conflicting with an existing preference => "activate" BOTH stay
  (the user resolves preferences; never supersede a preference);
- otherwise useful and new => "activate";
- every candidateIndex from the input MUST appear exactly once;
- output the JSON object only — no markdown fence, no commentary.`

/**
 * Rollup: compress the injectable working set into one summary that fits the
 * packet budget. It replaces direct L1 injection only while L1 overflows, so
 * the instruction optimizes for coverage-per-token, not prose.
 */
export const rollupSystemPrompt = (): string =>
  `You organise a repository's stored memories into a few SCENARIO briefings.

A scenario is a piece of work someone would resume as a unit — "the auth
refactor", "CI and release", "the storage layer". It is a topic, not a
directory: one scenario may span several parts of the codebase.

Return STRICT JSON: {"scenarios":[{"title":string,"body":string}]}

Rules:
- at most ${ROLLUP_MAX_SCENARIOS} scenarios; prefer FEWER, larger ones over many thin ones;
- title: the scenario's name, ≤${ROLLUP_TITLE_TARGET_CHARS} chars, no prefix like "Scenario:";
- body: ≤${ROLLUP_TARGET_CHARS} chars, the briefing for that scenario alone;
- assign every input memory to exactly ONE scenario; when something fits
  nowhere, put it in a scenario titled "General";
- preserve every distinct item whatever its kind; drop only wording;
- keep concrete identifiers verbatim (commands, paths, tool names, versions);
- state rules as rules ("use pnpm, never npm"), not as narrative;
- omit anything you cannot state precisely — a lost detail beats a wrong one;
- output the JSON object only — no markdown fence, no commentary.`

/**
 * Persona (L3): judge whether the stored portrait still describes the person,
 * and rewrite it only when it does not.
 *
 * "Keep" is a first-class answer, and the reason this is a judgement rather
 * than an unconditional regeneration: L3 must not wobble with every stored
 * preference (ADR 0004). Code cannot decide "this person changed" — no count
 * of edits or elapsed days correlates with it — so the question goes to the
 * model directly instead of being approximated in code.
 *
 * The portrait describes HOW TO WORK WITH someone, never who they are:
 * demographics are neither ours to infer nor useful to the next session.
 */
export const personaSystemPrompt = (): string =>
  `You maintain a short portrait of ONE person: how they want to be worked with.

You receive their stored preferences and portable lessons, plus the CURRENT
portrait when one exists.

Return STRICT JSON: {"verdict":"keep"|"rewrite","body":string}

Rules:
- "keep" when the current portrait still describes this person — say keep
  even if wording could be prettier; churn costs more than an imperfect line;
- "rewrite" only when the portrait now contradicts the memories, or misses a
  standing trait that shows up across several of them;
- body: the portrait to store, ≤${PERSONA_TARGET_CHARS} chars, written for
  another assistant to read at the start of a session;
- describe working style only — language, tone, depth, format, what earns
  trust, what annoys them. Never infer identity, demographics, or employer;
- generalise: state the disposition behind the preferences, not a list of
  them ("wants claims backed by evidence", not "asked for a test on Tuesday");
- omit anything you cannot support from the memories given;
- with "keep" you may echo the current body; it is ignored either way;
- output the JSON object only — no markdown fence, no commentary.`
