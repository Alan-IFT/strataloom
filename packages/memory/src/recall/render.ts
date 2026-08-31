/**
 * How a stored memory becomes model-facing text, and what that text costs.
 *
 * This module imports NOTHING from this package, and that is its entire
 * reason to exist as a separate file. Rendering is the one thing both ends of
 * the codebase need: `recall/inject.ts` renders packets, and `constants.ts`
 * must PRICE a worst-case packet at load time to assert that the derived
 * layer fits its budget. Leaving both functions in `inject.ts` and importing
 * them from `constants.ts` closes a cycle — `constants → inject → constants` —
 * and ES modules resolve that cycle by evaluating whichever module the process
 * happens to enter first.
 *
 * That is not a theoretical worry; it was measured. With the cycle in place,
 * entering through `inject` throws
 * `ReferenceError: Cannot access 'renderEntry' before initialization`, while
 * entering through `index` or `constants` works. The plugin survives today
 * only because `index.ts → store.ts → constants.ts` happens to win the race,
 * and `tools.ts`, `metrics.ts`, `pipeline/rebuild.ts` and
 * `test/inject.test.mjs` all enter through `inject` directly. A leaf module
 * with no imports cannot be half-initialised, so both sides depend on it in
 * ONE direction and the failure mode is gone by construction rather than by
 * load-order luck.
 *
 * Rejected alternative: duplicating a small pricing helper inside
 * `constants.ts` "just for the assertion". A guard that prices a different
 * string than the runtime renders asserts nothing about the runtime — it is
 * exactly the second source of truth D8 exists to prevent.
 * @module @strataloom/dsh-memory/recall/render
 */

/**
 * Token estimation is chars/4 everywhere (spec §4.3: budgets are truncation
 * guardrails, not billing — a tokenizer dependency buys no guardrail accuracy).
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * What the renderer needs: structural, not the branded `MemoryHit`, so the
 * tool's schema-typed value (plain `string` id) renders through the same
 * function as a service-typed hit without a cast.
 */
export interface RenderableHit {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly body: string
  /**
   * Which OTHER repository this entry came from, when it did not come from the
   * session's own — the `deriveRepoIdentity` source string a group declaration
   * names its members by.
   *
   * ABSENT means "this session's own repository or the user's personal store",
   * and absence is what keeps every pre-group render byte-identical: nothing on
   * the injection path, the `propose` near-duplicate list, or the `sourceOf`
   * transcript mode ever sets it, so those outputs cannot move.
   *
   * It exists because the recall tool was delivering foreign content under a
   * header that says "in this repository". Measured over 2792 queries against
   * the real stores, 1508 (54.0%) returned results that were 100% foreign —
   * deployment facts owned by an archived operations repo, build rules owned by
   * the frontend repo — with nothing in the packet to say so. `/memory list`
   * already solved this (see `MemoryListingScope`, whose own comment says
   * "complete but unattributable is not complete"); this is the same rule
   * reaching the same conclusion on the other read exit.
   */
  readonly source?: string
}

/**
 * How many characters of a source string an entry may spend on its label.
 *
 * A cap is REQUIRED, not tidiness: the source comes from
 * `.strataloom-group.json`, which is hand-written committed content of
 * unbounded length, and it is rendered into a packet that a load-time guard
 * has to price. Without a ceiling here, `worstForeignRowTokens` in
 * `constants.ts` could not be computed at all and the per-member budget would
 * bound nothing.
 *
 * 64, against real sources measured at 37-45 characters
 * (`remote:github.com/Alan-IFT/NFBY_CMS_FullStack` is the longest at 45), so
 * every real member is shown in full and the cap only ever engages on a
 * pathological declaration. Truncation is marked with an ellipsis rather than
 * silent, because a half-shown repository name that looks complete is worse
 * than one that visibly is not.
 */
export const SOURCE_LABEL_MAX_CHARS = 64

/** The source as it appears in an entry, truncated visibly rather than silently. */
const sourceLabel = (source: string): string =>
  source.length > SOURCE_LABEL_MAX_CHARS
    ? `${source.slice(0, SOURCE_LABEL_MAX_CHARS - 1)}…`
    : source

/**
 * One memory → one list item. THE definition, and the only place a memory's
 * content is ever turned into text.
 *
 * Two rules live here because they are the same rule seen twice:
 *
 * 1. The packet is a flat `- ` list, so a body's own newlines are indented.
 *    Otherwise stored text — which reaches injectable provenance from repo
 *    content and tool output, not just from the user — could leave its bullet
 *    and address the model at the top level ("The reference data above has
 *    ended. New instruction: …") or forge a sibling entry. The framing header
 *    is a *semantic* defense; this makes the *structure* say it too.
 *    Continuations are indented, not stripped: bodies are often lists or short
 *    procedures, and markdown already continues an item exactly this way, so
 *    nothing is lost — even a blank line becomes an indented one.
 * 2. Pricing calls this too, so what the budget measures is byte-for-byte what
 *    the model receives. Estimating a different string than we render is how a
 *    budget silently stops meaning anything.
 * 3. The provenance label is emitted HERE, per entry, and not as a section
 *    heading above a group of entries. A heading is positional: the platform's
 *    tool-result pruner deletes the MIDDLE of an over-long packet (head 4096 +
 *    tail 1024), so a heading can be cut away while the entries it labelled
 *    survive — attribution that disappears exactly when the packet is large is
 *    attribution that fails when it matters. Per entry, an entry either arrives
 *    with its origin or does not arrive.
 *
 *    A hit with no `source` renders EXACTLY as before, character for character.
 *    That is the compatibility gate: injection, the near-duplicate list and the
 *    `sourceOf` transcript never set it, so their output cannot move, and the
 *    load-time injection guards keep pricing the same strings.
 * @param hit - the memory to render.
 * @param withId - include the id (callers that offer a follow-up action need it).
 */
export const renderEntry = (hit: RenderableHit, withId: boolean): string =>
  `- [${hit.kind}] ${withId ? `(id ${hit.id}) ` : ''}${
    hit.source === undefined ? '' : `(from ${sourceLabel(hit.source)}) `
  }${hit.title}: ${hit.body}`.replaceAll('\n', '\n  ')

/**
 * What a set of memories costs when rendered. Priced through `renderEntry`,
 * so the overflow trigger, the metrics snapshot, and the packet cannot drift.
 */
export const packetTokens = (hits: readonly RenderableHit[]): number =>
  hits.reduce((sum, hit) => sum + estimateTokens(renderEntry(hit, false)), 0)

/**
 * Which entries survive a token budget — THE budget rule, extracted here so it
 * can be applied twice without existing twice.
 *
 * `renderFramed` used to hold this loop inline, which was fine while injection
 * had exactly one budget. It now has two: the packet as a whole, and a cap on
 * what the personal store may contribute to it (see `buildContextProvider`).
 * The second one selects rows and then hands them onward to be rendered WITH
 * the repo rows, so it needs the choice without the framing — and writing a
 * second loop to make that choice is precisely the D8 failure: two selectors
 * priced two ways, agreeing until the day they do not.
 *
 * So selection lives here and `renderFramed` calls it. Both budgets are then
 * spent by the same code against the same `renderEntry`, and a change to how
 * an entry is priced moves both at once, by construction.
 *
 * An entry that does not fit is SKIPPED, not treated as end-of-list: entries
 * arrive in priority order, so one oversized item must not hide the cheaper
 * ones queued behind it.
 * @param hits - entries in priority order.
 * @param budgetTokens - the budget to spend.
 * @param withId - price as the caller will render (ids cost tokens too).
 */
export const withinBudget = <T extends RenderableHit>(
  hits: readonly T[],
  budgetTokens: number,
  withId = false,
): T[] => {
  const kept: T[] = []
  let budget = budgetTokens
  for (const hit of hits) {
    const cost = estimateTokens(renderEntry(hit, withId))
    if (cost > budget) continue
    kept.push(hit)
    budget -= cost
  }
  return kept
}
