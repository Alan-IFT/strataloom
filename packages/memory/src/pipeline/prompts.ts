/**
 * Pipeline prompt templates, versioned (spec §1: prompts.ts 带版本号).
 * The version rides every job payload so a replayed job renders the prompt
 * it was enqueued for.
 * @module @strataloom/dsh-memory/pipeline/prompts
 */

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

Return STRICT JSON: {"candidates":[{"title":string,"body":string,"kind":"fact"|"preference"|"procedure","sourceSeqs":number[]}]}

Rules:
- at most 5 candidates; return {"candidates":[]} when nothing is durable;
- a candidate must be useful BEYOND this session (facts about the repo,
  user preferences, working procedures) — no task-progress notes, no
  one-off values, no secrets/credentials/tokens (omit them entirely);
- title: one imperative line ≤120 chars; body: ≤800 chars, self-contained;
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
  `You compress a repository's stored memories into ONE compact briefing.

Return PLAIN TEXT (no JSON, no markdown fence), at most 900 characters.

Rules:
- preserve every distinct fact, preference, and procedure; drop only wording;
- group related items into single lines instead of repeating context;
- keep concrete identifiers verbatim (commands, paths, tool names, versions);
- state rules as rules ("use pnpm, never npm"), not as narrative;
- omit anything you cannot state precisely — a lost detail beats a wrong one;
- write nothing but the briefing text.`
