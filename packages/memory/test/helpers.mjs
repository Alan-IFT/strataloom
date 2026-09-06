/**
 * Test helpers: temp store roots, fake agents shaped like the platform's
 * duck-typed surface, a minimal ctx stub for units that only need
 * agents.get / logger / ctx.get, and the SHARED honesty guards every
 * model-facing string in this plugin must pass.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after } from 'node:test'
import { StoreRegistry } from '../lib/store/store.js'

const quiet = { warn() {}, info() {}, error() {}, debug() {} }

// ----------------------------------------------------- temp root ledger ----

/**
 * Roots handed out by `tempRoot()` that nothing has deleted yet, and every
 * root it has EVER handed out. `live` drives the sweep; `created` drives the
 * guard, which must still see a root after `cleanup()` forgot it (see below).
 */
const live = new Set()
const created = new Set()

/**
 * ⛔ THE DISCRIMINANT IS "IS THE OUTER HANDLE RETAINED OR DISCARDED", NOT
 * "DOES THE TEST CLEAN UP".
 *
 * `mkdtempSync` returns the ONLY handle to the directory it just made. Call
 * sites of the shape `join(tempRoot(), 'repo')` or `cwd: tempRoot()` keep the
 * inner path or pass the value straight through, and the outer
 * `/tmp/strataloom-test-XXXXXX` name is never bound to anything — so no
 * `cleanup()` written at that call site CAN name it. The failure is not
 * negligence at the call site; it is unreachability.
 *
 * That is why cleaning up is not the discriminant: `store.test.mjs` calls
 * `tempRoot()` 20 times and leaks 0, because it writes `const root =
 * tempRoot()` and later `cleanup(root)` — the handle is retained. Measured at
 * HEAD, per file, `node --test <file>` with a sorted-snapshot `comm -13` diff
 * of `/tmp`:
 *
 * ```
 * group=102  layers=83  service=11  e2e=7  inject=6  command=2
 * auto-extract=2   (the other 9 test files: 0)           sum = 213
 * ```
 * (16 test files, 7 of them leak, so 9 leak nothing: guidance, jobs,
 * lifecycle, package, pipeline, pipeline-e2e, repo-key, resilience, store.)
 * and the full suite leaks exactly 213 per run, deterministic across three
 * independent runs, always 309 pass / 0 fail. At a measured mean of 43.4
 * inodes per leaked root that is ~9,270 inodes per run, and `/tmp` is on the
 * same filesystem as `/`, so it grows without bound against the machine's
 * global inode budget.
 *
 * The fix is to retain the handle HERE, at the single acquisition point,
 * instead of asking 15 call sites to retain something they never received.
 */
export const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'strataloom-test-'))
  live.add(dir)
  created.add(dir)
  return dir
}

export const cleanup = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
  // Drop it from the sweep set, NOT from `created`: the guard below must still
  // check this path on disk. `cleanup()` is best-effort and swallows its own
  // failure, so "cleanup was called" is not evidence the directory is gone.
  live.delete(dir)
}

/**
 * The late sweep. It only ADDS a last resort — it moves no existing
 * `cleanup(root)` call, and every one of them still runs exactly where it runs
 * today.
 *
 * ⛔ WHY `node:test`'s FILE-LEVEL `after()` AND NOT `process.on('exit')` —
 * AND THE TWO ARE NOT ORDERED. `after()` IS NOT A SUPERSET OF `exit`.
 * An earlier draft of this comment said an `exit` handler "does cover
 * assertion failure, uncaught exception and an explicit `process.exit()`",
 * which is true of `exit` but, sitting under this heading, invited the reader
 * to conclude `after()` is at least as good everywhere. It is not. Full
 * matrix, two helpers differing ONLY in the teardown mechanism, three
 * independent runs per cell under a private TMPDIR, reported as rc/leak:
 *
 * ```
 * failure mode                       after()      process.on('exit')
 * assertion failure                  1/0          1/0
 * RC=124 hang (live 30s interval)    124/0  <==   124/1
 * uncaught async rejection           1/0          1/0
 * process.exit() mid-test            1/1     ==>  1/0
 * SIGTERM mid-test                   1/1          1/1
 * SIGKILL mid-test                   137/1        137/1
 * ```
 * They TRADE wins. `after()` runs when the file's tests finish, so it fires
 * before a stuck process is killed — that is the RC=124 row. `process.exit()`
 * tears the process down without ever finishing the tests, so the `after()`
 * hook never runs — that is the row `after()` loses.
 *
 * `after()` is still the right choice here, and the reason is a property of
 * THIS repository rather than a general ranking: the RC=124 hang is a
 * documented, actually-observed shape in this test suite, whereas
 * `process.exit()` does not occur in this package at all. Verified, not
 * assumed — the only hit in the whole package is this very comment:
 * ```
 * grep -rn 'process\.exit' packages/memory/{src,lib,test}
 *   -> test/helpers.mjs: (this comment)     and nothing else
 * ```
 * If someone later introduces `process.exit()` into a test or into `src/`,
 * this trade-off flips and this comment must be revisited.
 *
 * ⛔ WHAT THIS STILL LEAKS, STATED HONESTLY — THREE MODES, NOT ONE.
 * Measured above, each leaks exactly 1 (the root held by the running test):
 *   - SIGKILL mid-test (rc=137) — irreducible; no in-process handler can beat
 *     it, and neither mechanism does.
 *   - SIGTERM mid-test (rc=1) — BOTH mechanisms leak; `node --test` does not
 *     drain file-level `after()` hooks on the signal path.
 *   - `process.exit()` mid-test — `after()` leaks 1 where an `exit` handler
 *     would not; accepted only because this package contains no such call.
 * This sweep closes the deterministic 213-per-run leak and the RC=124 hang. It
 * does NOT promise total coverage, and it is not a superset of the mechanism
 * it replaces.
 *
 * ⛔ THE DELETION PREDICATE IS IDENTITY, NEVER A PATTERN. Only values
 * `mkdtempSync` returned in THIS process are deleted. It never scans `/tmp`,
 * never globs, never prefix-matches `strataloom-test-*` — that is exactly what
 * would delete a CONCURRENT run's live directories. `node --test` runs one
 * process per file, so this Set is naturally isolated to one file's roots.
 */
after(() => {
  for (const dir of live) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort; the guard below reports whatever survives
    }
  }
  live.clear()
})

/**
 * The regression guard, registered automatically beside the sweep.
 *
 * ⛔ IT IS AN `after()` HOOK, NOT A `test()`. File-level `after()` hooks —
 * including the sweep above — run AFTER every test in the file. A guard
 * written as a `test()` therefore observes the state BEFORE the sweep and goes
 * RED on correctly-fixed code. Measured on a two-module probe: hooks run FIFO
 * in registration order ACROSS modules, so the helper's sweep (registered at
 * import) runs first and this guard reads post-sweep state:
 * `HELPER SWEEP, size=1` then `GUARD after, size=0`, 1 pass / 0 fail.
 *
 * ⛔ IT ASKS THE DISK, NOT THE SET. Asserting `live.size === 0` measures only
 * that the sweep ran its loop, and a sweep that clears the set without
 * deleting anything passes it. Measured on the probe with a deliberately
 * broken `live.clear()`-only sweep:
 *
 * ```
 * broken sweep, `live.size` guard   -> pass 1 / fail 0   (guard fooled)
 * broken sweep, on-disk guard       -> pass 1 / fail 1   (guard fires)
 * missing sweep, either guard       -> pass 1 / fail 1
 * correct sweep, either guard       -> pass 1 / fail 0
 * ```
 * So the guard checks `existsSync` on every root ever handed out. That is why
 * `cleanup()` removes a root from `live` but leaves it in `created`.
 *
 * ⛔ IT IS REGISTERED HERE, NOT ONE LINE PER TEST FILE. This repo already
 * registers "one rule, N execution points, only some guarded" as its recurring
 * defect ("e2e probes: three files, three implementations"). A per-file line
 * is a per-file line somebody can forget, and it needs a completeness grep to
 * police it. Registering in the module that OWNS the acquisition point makes
 * the guard unmissable by construction: a file can only leak a
 * `strataloom-test-` root by calling `tempRoot()`, calling it requires
 * importing this module, and importing this module registers both hooks.
 * There is no enumeration to keep in sync — 11 execution points collapse to 1.
 *
 * ⛔ AND A PER-FILE LINE WOULD ALREADY BE INCOMPLETE, which is measured, not
 * predicted. `tempRoot()` is not the only acquisition path a test file uses:
 * `openRegistry()` below calls it internally, and three files (`jobs`,
 * `pipeline`, `pipeline-e2e`) use `openRegistry` while never writing the word
 * `tempRoot`. The natural completeness grep for a per-file guard —
 * `grep -l 'tempRoot' test/*.test.mjs` — does not list them, so it would have
 * certified a file set that omits a real acquisition path. Probed directly
 * with a scratch test that calls only `openRegistry()`, with the sweep
 * disabled: `pass 1 / fail 1`, `zz-probe.test.mjs leaked 1 temp root(s)`. The
 * helper-registered guard covers it; a `tempRoot`-keyed enumeration would not.
 *
 * The completeness criterion for THIS design is that no test file may reach
 * `mkdtempSync` for a `strataloom-test-` root except through here:
 * ```
 * grep -l 'strataloom-test-' test/*.test.mjs   # must print nothing
 * ```
 * Note that "grep -c mkdtempSync test/*.mjs must be 1" is NOT the criterion and
 * is NOT true of this tree: `package.test.mjs` calls `mkdtempSync` directly for
 * a `strataloom-pack-` staging dir, retains that handle, removes it itself, and
 * leaks 0 (measured). It is a correct call site, not an unfixed one.
 *
 * A passing hook is not a test and does not change the reported test count
 * (measured: 309 before, 309 after). A FAILING hook is reported as an extra
 * failing item, which is the point: with the sweep deliberately disabled the
 * suite reported `tests 316 / pass 309 / fail 7` — the same 309 passes, plus
 * one failure for each of the seven leaking files, with counts 102, 83, 11, 7,
 * 6, 2, 2 that sum to the measured 213.
 *
 * ⛔ THE MESSAGE NAMES THE TEST FILE AND CAPS THE LIST, because the first draft
 * did neither and both were measured to hurt. `node --test` attributes a
 * helper-registered hook failure to the file the hook was REGISTERED in, so
 * every one of those seven failures printed as
 * `✖ .../test/helpers.mjs` — seven identical labels, none naming the file that
 * actually leaked. `process.argv[1]` is the file under test, so the message
 * carries it. And the `group.test.mjs` failure dumped 102 absolute paths into
 * the diff, burying the number that matters; the count is what a reader acts
 * on, so the list is truncated to the first few as a sample.
 */
const GUARD_SAMPLE = 5

/**
 * THE GUARD'S PREDICATE, named so the self-check below can exercise the very
 * function the guard calls. Inlining it would leave the self-check testing a
 * copy of the rule instead of the rule.
 */
const leakedRoots = () => [...created].filter((dir) => existsSync(dir))

after(() => {
  const survivors = leakedRoots()
  if (survivors.length === 0) return
  const where = process.argv[1] ? basename(process.argv[1]) : 'this file'
  const sample = survivors.slice(0, GUARD_SAMPLE).join(', ')
  const more = survivors.length > GUARD_SAMPLE ? `, ... (+${survivors.length - GUARD_SAMPLE} more)` : ''
  assert.fail(
    `${where} leaked ${survivors.length} temp root(s) under ${tmpdir()}: ${sample}${more}. ` +
      'Each was created by tempRoot() and still exists after the sweep in test/helpers.mjs.',
  )
})

/**
 * THE GUARD'S OWN NEGATIVE CONTROL — a third `after()` hook that proves, on
 * every single test file, that the guard above is still CAPABLE of firing.
 *
 * ⛔ WHY THIS EXISTS: TWO MUTATIONS SURVIVED THE SUITE FULLY GREEN.
 * Code review mutated the shipped helper and measured 309/309/0, rc=0, delta=0
 * for BOTH — the fix kept working, and the guard went permanently deaf:
 *
 * ```
 * D2  delete `created.add(dir)` from tempRoot()          309 pass / 0 fail   SURVIVED
 * D3  guard reads `[...live]` instead of the disk        309 pass / 0 fail   SURVIVED
 * ```
 * (Both independently re-measured here under a private TMPDIR before writing
 * this hook.) Neither breaks the sweep, so nothing goes red; they only destroy
 * the DETECTOR. A guard whose failure mode is silence needs a control.
 *
 * ⛔ WHY IT IS AN END-TO-END NEGATIVE CONTROL AND NOT A LEDGER-SHAPE ASSERTION.
 * Review proposed
 * `if (created.size > 0 && [...created].every((d) => live.has(d))) assert.fail(...)`
 * and explicitly asked whether it kills both. MEASURED: IT KILLS NEITHER —
 * it never fires on anything, including correct code:
 *
 * ```
 * candidate + correct helper   309 pass / 0 fail       (does not fire)
 * candidate + D2               309 pass / 0 fail       SURVIVED
 * candidate + D3               309 pass / 0 fail       SURVIVED
 * ```
 * The reason is structural: hooks are FIFO, so the sweep has already run
 * `live.clear()` by the time any later hook looks. `live` is therefore ALWAYS
 * empty here, so `every((d) => live.has(d))` is false whenever `created` is
 * non-empty, and the `created.size > 0` term short-circuits when it is empty.
 * The predicate is unsatisfiable in both directions — a dead assertion. It was
 * offered as an untested candidate and it is recorded here as falsified.
 *
 * What both mutations actually break is the same thing: THE GUARD CAN NO
 * LONGER SEE A ROOT THAT IS REALLY ON DISK. So this control asserts exactly
 * that capability, by construction rather than by inspection:
 *
 *   A. make a real directory through `tempRoot()` — the acquisition point the
 *      guard trusts — and assert `leakedRoots()` reports it;
 *   B. remove it from `live` WITHOUT deleting it, and assert `leakedRoots()`
 *      STILL reports it;
 *   C. delete it for real and assert `leakedRoots()` goes quiet.
 *
 * ⛔ STEP B IS THE WHOLE POINT, AND THE COMMENT THAT USED TO STAND HERE WAS
 * FALSE. THE FALSIFIED TEXT IS KEPT VERBATIM, PER HOUSE RULE:
 *
 *     "D3 (predicate = live) -> STEP 3 PASSES ... STEP 4 fires instead: after
 *      the rmSync the probe is still in `live`. ... So step 4 is not merely a
 *      symmetry nicety — it is the ONLY step that catches a predicate reading
 *      the wrong ledger."
 *
 * That is wrong, and it was a FABRICATED REASON FOR A REAL ASSERTION — the
 * repository's signature defect, caught here for the fourth time (three times
 * by review, once by me). What went wrong is worth stating exactly, because it
 * is a measurement error, not a typo:
 *
 * I mutated the predicate to a bare `[...live]`, DROPPING the `existsSync`
 * filter, and that mutant does die at the old step 4. But the realistic
 * mutant keeps the filter — `[...live].filter((d) => existsSync(d))` — and
 * that one SURVIVED the old control completely. Both readings are real; they
 * are simply different mutants, and I generalised from the weaker one:
 *
 * ```
 * predicate = [...live]                            -> rc=1  fail 14   (dies)
 * predicate = [...live].filter(d => existsSync(d)) -> rc=0  309/0     SURVIVED
 * ```
 * The old step 4 CANNOT distinguish them, and that is arithmetic rather than
 * opinion: it ran after `rmSync(probe)`, so `existsSync(probe)` is false, so
 * BOTH predicates filter the probe out and BOTH pass. Isolated:
 *
 * ```
 * old step3   good=true  bad=true      <- both pass, no discrimination
 * old step4   good=true  bad=true      <- both pass, no discrimination
 * step B      good=true  bad=FALSE     <- separates them
 * ```
 * Step A cannot catch it either: right after `tempRoot()` the probe is in
 * `live` AND in `created` AND on disk, so every predicate reports it.
 *
 * The ONLY state in which reading `live` differs from reading `created` is
 * "on disk, but already removed from `live`" — which is precisely the state
 * `cleanup()` creates, and precisely the state a broken sweep leaves behind.
 * Step B constructs that state deliberately. This shape was proposed by
 * review as an unverified candidate; it is used here because it measured red
 * on the surviving mutant, not because it was suggested.
 *
 * ⛔ WHICH OF A/B/C ARE ACTUALLY LOAD-BEARING — MEASURED, AND ONLY ONE IS.
 * Do not read the three steps as three independent guards; that is exactly the
 * kind of overclaim this comment was rewritten to stop making. Dropping each
 * step and re-running the mutant it supposedly catches:
 *
 * ```
 * drop STEP B, apply D3 -> rc=0  309/0    SURVIVES  => B is load-bearing
 * drop STEP A, apply D2 -> rc=1  fail 14  still dies => A is not the only catch
 * drop STEP C, predicate that never filters by existsSync
 *                       -> rc=1  fail 14  still dies => C is not the only catch
 * ```
 * With step A removed, D2 is still caught — by step B, which also requires the
 * probe to be reported. With step C removed, a predicate that never filters is
 * still caught, but by the MAIN GUARD above rather than by this control: it
 * reports the file's own cleaned-up roots and fails with "...leaked 2 temp
 * root(s)...". So step C has no mutant of its own in this suite.
 *
 * A and C are kept anyway, and the honest reason is DIAGNOSIS, NOT DETECTION:
 * they split one "the detector is broken" failure into three distinct
 * messages, so a reader learns which property broke instead of bisecting. They
 * cost one mkdir and one rmdir. If a later round enforces one-assertion-one-
 * mutant, STEP B is the one that may not be deleted.
 *
 * The 14 failures are one per test file that imports this module
 * (`grep -l "from './helpers.mjs'" test/*.test.mjs` = 14), which is the
 * intended blast radius: the detector is broken everywhere at once.
 *
 * ⛔ FULL MUTANT MATRIX AGAINST THIS CONTROL — every row re-measured after the
 * step-B rewrite, each under its own private TMPDIR, each with the mutation
 * verified to have LANDED (the earlier round reported a row that had been
 * applied to a stale code shape, which is how the false claim above survived):
 *
 * ```
 * correct code                                        rc=0  309/0     leak 0
 * D2  drop `created.add(dir)`                         rc=1  fail 14   leak 0    "gone deaf"
 * D3  predicate [...live].filter(existsSync)          rc=1  fail 14   leak 0    "wrong ledger"
 * C1  drop `created.add` + sweep returns early        rc=1  fail 14   leak 213  "gone deaf"
 * C2  sweep clear-only + predicate [...live].filter   rc=1  fail 14   leak 213  "wrong ledger"
 * ```
 * C1 and C2 still leak 213 under the mutant because their sweep really is
 * broken; what this control changes is that the suite now SAYS SO instead of
 * reporting a clean 309/309/0.
 *
 * It runs LAST (FIFO) and leaves the ledger exactly as it found it, so it
 * cannot make the guard above fire. It costs one mkdir + one rmdir per file.
 */
after(() => {
  const probe = tempRoot()
  try {
    // STEP A — the predicate sees a root that is registered and on disk.
    assert.ok(
      leakedRoots().includes(probe),
      'the temp-root guard has gone deaf: a directory that exists on disk and was handed out by ' +
        'tempRoot() is NOT reported by the guard predicate. Check that tempRoot() still records ' +
        'into `created` — without that record the guard can never report anything.',
    )
    // STEP B — THE DISCRIMINATING STATE: still on disk, but no longer in
    // `live`. This is exactly what `cleanup()` produces, and it is the ONLY
    // state in which reading `live` differs from reading `created`.
    live.delete(probe)
    assert.ok(
      leakedRoots().includes(probe),
      'the temp-root guard reads the wrong ledger: a directory that is STILL ON DISK stopped ' +
        'being reported as soon as it left the `live` set. `live` is emptied by cleanup() and by ' +
        'the sweep, so a predicate built on it goes silent precisely when a real leak survives ' +
        'a broken sweep. The predicate must filter `created` by existsSync, not `live`.',
    )
    // STEP C — and it stops reporting once the directory is really gone, so it
    // cannot fire on correct code.
    rmSync(probe, { recursive: true, force: true })
    assert.ok(
      !leakedRoots().includes(probe),
      'the temp-root guard reports a directory that is no longer on disk, so it cannot ' +
        'distinguish a leak from a cleaned-up root and would fire on correct code.',
    )
  } finally {
    // Leave no trace: this control must not itself become a leak, and must not
    // leave the probe in `created` where the guard above would see it.
    rmSync(probe, { recursive: true, force: true })
    live.delete(probe)
    created.delete(probe)
  }
})

/** The roots this process created that are still on disk. Exported for diagnosis. */
export const survivingRoots = () => leakedRoots()

/** Open a registry over a temp root; returns { root, registry }. */
export const openRegistry = () => {
  const root = tempRoot()
  const registry = new StoreRegistry(root, quiet)
  return { root, registry }
}

/**
 * A fake Agent: only the fields the plugin reads (id, options, status,
 * session.header/id/events). `depth`/`origin` shape the lineage predicate;
 * `runtimeDepth` feeds delegationDepthOf's max(header, runtime).
 */
export const fakeAgent = ({
  id = 'sess-1',
  cwd,
  parentSession,
  origin,
  delegationDepth,
  runtimeDepth,
  events = [],
  status = 'idle',
} = {}) => {
  const header = { version: 0, id, createdAt: 0 }
  if (cwd !== undefined) header.cwd = cwd
  if (parentSession !== undefined) header.parentSession = parentSession
  if (origin !== undefined) header.origin = origin
  if (delegationDepth !== undefined) header.delegationDepth = delegationDepth
  const options = {}
  if (runtimeDepth !== undefined) options.subagentDepth = runtimeDepth
  return {
    id,
    options,
    status,
    session: { id, header, events },
  }
}

/** Minimal ctx stub: live-agent map + logger + soft-dep map. */
export const fakeCtx = ({ agents = [], services = {} } = {}) => {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  return {
    agents: {
      get: (id) => byId.get(id),
      list: () => [...byId.values()],
    },
    logger: quiet,
    get: (name) => services[name],
  }
}

/** Session event helpers for transcript-shaped tests. */
export const turnEvents = (turn, entries) => {
  let seq = 1
  const events = [{ type: 'turn/start', seq: seq++, time: 0, data: { turn } }]
  for (const entry of entries) {
    events.push({ ...entry, seq: seq++, time: 0 })
  }
  events.push({ type: 'turn/end', seq: seq++, time: 0, data: { turn, reason: 'completed' } })
  return events
}

export const userMessageEvent = (text) => ({
  type: 'user/message',
  data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

/**
 * A `user/message` carrying an arbitrary platform source shape. Continuable
 * subagents deliver their real content this way — not through tool/result —
 * so every source-kind classification test builds its event here.
 */
export const sourcedMessageEvent = (text, source) => ({
  type: 'user/message',
  data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source },
})

export const assistantMessageEvent = (turn, text) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: 0,
    message: {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  },
})

export const toolResultEvent = (turn, callId, text) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 0,
    message: {
      id: 't',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  },
})

/**
 * A `tool/call` event. `args` is the RAW argument string the platform records
 * — the model's unparsed output — so tests can hand it anything a model could
 * produce, including strings that are not JSON at all.
 */
export const toolCallEvent = (turn, callId, name, args = '{}') => ({
  type: 'tool/call',
  data: { turn, step: 0, callId, name, arguments: args },
})

// ------------------------------------------------ shared honesty guards ----

/**
 * The FALSE-ADVICE SET: every actionable payload this plugin has shipped and
 * then had to delete, plus the shapes they generalise to.
 *
 * ⛔ WHY THIS LIVES IN `helpers.mjs` AND NOT IN A TEST FILE (rework, step 3c).
 * The previous round factored these guards into `assertHonestRefusal` inside
 * `layers.test.mjs` and applied them to the two `service.ts` sentences — and
 * to NOTHING ELSE. The three MODEL-FACING DESCRIPTION STRINGS the same round
 * edited (`tools.ts`'s tool description, its `sourceOf` parameter description,
 * and `GUIDANCE_SECTION.text`) carried no guard at all, and three mutations
 * proven landed in `lib/` ALL SURVIVED at 298/298/0:
 *
 * ```
 * MK  sourceOf param: `The memory is unaffected either way.`
 *                  -> `Forget it and recall it again to fix this.`   298/298/0
 * MM  tool description + the literal v0.4.16 payload
 *     `Start a session inside that checkout and retry.`              298/298/0
 * MN  GUIDANCE_SECTION + `If none, forget it.` (157 <= 160 tokens,
 *     so the load-time budget assertion does not catch it)           298/298/0
 * ```
 *
 * That is the SIXTH occurrence of "one rule, N execution points, only some
 * guarded"; the slice this time was *service sentences vs. tool-description
 * sentences*. A helper that lives in the file holding one slice's tests is a
 * helper the other slice will not import. It lives here, beside `fakeAgent`,
 * because `layers.test.mjs` and `group.test.mjs` both already import from
 * here, and so will whatever file states the next model-facing string.
 *
 * EACH ENTRY IS A REAL DELETED PAYLOAD OR ITS GENERALISATION, not a guessed
 * bad word:
 *   - `start a session inside` / `cannot be removed until a checkout` —
 *     v0.4.16's two falsified halves.
 *   - `forget the underlying` / `recall it to get its id` — the home sentence
 *     v0.4.16 proved false across the group boundary.
 *   - `rebuil|regenerat` — no rebuild produces a source passage; `rebuild.ts`
 *     writes derived rows with zero evidence rows.
 *   - `try again|retry` — MK's shape: advice to re-run something whose outcome
 *     cannot change.
 *   - DESTRUCTIVE IMPERATIVE — see below; this one is a PROPERTY, not a
 *     spelling, and it is the entry that had to be rewritten.
 *
 * ⛔ THE DESTRUCTIVE-IMPERATIVE ENTRY IS A PROPERTY BECAUSE A SPELLING WAS NOT
 * ENOUGH, and that was measured DURING this rework rather than assumed. The
 * first draft of this list pinned MK's exact words (`forget it and recall it
 * again`). Re-running the matrix showed MN's payload — `If none, forget it.` —
 * matched NOTHING here: MN turned red only INCIDENTALLY, killed by
 * `guidance.test.mjs`'s unrelated anchor-uniqueness assertion, which would
 * have gone on "guarding" this string right up until someone changed the
 * anchor. A guard that catches a payload by accident is not a guard, and
 * pinning rejected byte strings instead of the property is the exact criticism
 * (S1) this round already accepted once for `GUIDANCE_SECTION`. So the entry
 * states the property: THESE SURFACES DESCRIBE A READ, AND A READ SURFACE MAY
 * NOT INSTRUCT THE MODEL TO DESTROY A MEMORY.
 *
 * The pattern matches an imperative `forget` with an OBJECT (`forget it`,
 * `forget them`, `forget the entry`) and deliberately does NOT match the tool
 * NAME `memory_forget`, which every one of these strings legitimately
 * mentions — verified against all three live strings, which pass.
 */
export const FALSE_ADVICE_PATTERNS = [
  [/start a session inside/i, 'v0.4.16 deleted this: the destination cannot satisfy the request'],
  [/cannot be removed until a checkout/i, 'v0.4.16 deleted this: no checkout ever helps'],
  [/forget the underlying/i, 'true at home, false across the group boundary'],
  [/recall it to get its id/i, 'there is no derived->source mapping to recall'],
  [/rebuil|regenerat/i, 'no rebuild produces a source passage'],
  [
    /(?<!memory_)\bforget\s+(it|them|this|that|these|those|the\b)/i,
    'a READ surface told the model to destroy the memory it could not fully answer about ' +
      '(MK, MN); naming the `memory_forget` tool is fine, commanding a deletion is not',
  ],
  [/\b(try again|retry)\b/i, 'advice to repeat an operation whose outcome cannot change'],
]

/**
 * The CONTRADICTION SET: a READ path may never claim it changed or destroyed
 * anything. `ML` inverted a refusal's tail to "The memory has been deleted as
 * a result." and shipped fully green before these guards were shared.
 */
export const DESTRUCTION_CLAIM =
  /delet|removed|erased|discarded|no longer (exists|available)|has been (changed|modified)/i

/**
 * Assert one MODEL-FACING STRING carries no false advice and no destruction
 * claim. This is the half of `assertHonestRefusal` that is true of EVERY
 * string this plugin shows a model — a refusal sentence, a tool description, a
 * parameter description, the per-request guidance section — as opposed to the
 * half that is specific to a refusal (naming the id, saying the memory
 * survived, matching an exact expected sentence).
 *
 * Splitting it out this way is what lets the description tests and the
 * sentence tests share ONE definition instead of drifting: a new payload added
 * here is instantly enforced on all six surfaces, which is exactly what did
 * not happen when the guards lived next to one of them.
 */
export const assertNoFalseAdvice = (text, label) => {
  assert.ok(typeof text === 'string' && text.length > 0, `${label} must be a non-empty string`)
  for (const [pattern, why] of FALSE_ADVICE_PATTERNS) {
    assert.doesNotMatch(text, pattern, `${label} carries unfollowable advice — ${why}`)
  }
  assert.doesNotMatch(
    text,
    DESTRUCTION_CLAIM,
    `${label} claims something was deleted, removed or altered; these surfaces only READ`,
  )
}

/**
 * The guards EVERY honest refusal sentence must pass — ONE definition, called
 * from the derived cases, the raw case, the non-session-evidence cases, and
 * `group.test.mjs`'s member-domain cases alike.
 *
 * ⛔ WHY THIS EXISTS (rework, step 3b) and WHY IT MOVED HERE (step 3c). The
 * first version guarded the DERIVED sentence in five places and the RAW
 * sentence in none: review replaced the RAW sentence's tail with the literal
 * v0.4.16 false-advice payload and the suite stayed 291/291/0; replacing it
 * with `The memory has been deleted as a result.` ALSO stayed green — a READ
 * path claiming it deleted the user's memory, fully green. Step 3b routed both
 * sentences through one function. Step 3c found that function living inside
 * `layers.test.mjs`, where `group.test.mjs`'s 6h cases could not reach it and
 * had re-implemented NINE of its assertions inline — the precise drift a
 * shared helper exists to prevent — and the three tool-description strings had
 * no guard at all.
 *
 * The fix is not "copy the assertions": copies drift, and the next string
 * added starts unguarded again. Every refusal sentence runs this function, and
 * every model-facing description runs `assertNoFalseAdvice`, which this
 * function calls — so the two sets cannot diverge.
 *
 * `expected` is the WHOLE sentence, compared byte-for-byte with the id
 * substituted out. Full equality is what actually kills an appended lie: a
 * message satisfying every positive assertion AND carrying unfollowable advice
 * differs from `expected`, so it cannot pass. The named negatives are kept ON
 * TOP of it deliberately — they cost nothing and they make a failure say WHICH
 * property broke instead of dumping two long strings.
 */
export const assertHonestRefusal = (message, id, expected) => {
  // 1. NOT a denial of existence. This is the defect itself, and it is
  //    asserted NEGATIVELY because a positive-only assertion passes on a
  //    message that says the right thing AND the wrong thing (NEG1-NEG4).
  assert.doesNotMatch(
    message,
    /no memory with id/,
    'a row that is present and active must never be told it does not exist',
  )
  assert.doesNotMatch(message, /was forgotten/, 'nor that it was forgotten — it was not')
  // 2. It names the id, so the caller can match the answer to the line
  //    `recall` gave them. Read from the fixture, never hardcoded.
  assert.match(message, new RegExp(id))
  // 3. No unfollowable advice, and no claim that a read destroyed anything —
  //    the SAME set the tool descriptions are held to.
  assertNoFalseAdvice(message, `the refusal for ${id}`)
  // 4. It says the memory survived. The positive clause is asserted here and
  //    its contradiction in `assertNoFalseAdvice`: it is the whole clause that
  //    got inverted to "The memory has been deleted as a result." and shipped
  //    green.
  assert.match(message, /memory itself is unaffected/i, 'the read path damaged nothing, and says so')
  // 5. And the whole sentence, byte for byte. The id is substituted out
  //    because it is the caller's own input; everything else is the promise.
  assert.equal(
    message.split(id).join('<ID>'),
    expected.split(id).join('<ID>'),
    'the exact sentence is the promise — an extra clause appended to a message that satisfies ' +
      'every assertion above is precisely what survived review',
  )
}

/**
 * The two honest sentences `service.source` throws, as the caller receives
 * them. Exported so `layers.test.mjs` and `group.test.mjs` assert the SAME
 * bytes — 6h previously hardcoded its own copy of the derived sentence, which
 * is how a wording rework can leave one file green and the other stale.
 */
export const DERIVED_SENTENCE = (id) =>
  `${id} is a generated summary, not a memory recorded from a conversation, so there is no ` +
  'source conversation of its own to show. The memory itself is unaffected.'
export const RAW_SENTENCE = (id) =>
  `${id} is a stored memory, but no source conversation was recorded for it, so ` +
  'there is nothing to show. The memory itself is unaffected.'

// ------------------------------------------------------------ lib probe ----

const PKG_ROOT_PROBE = dirname(dirname(fileURLToPath(import.meta.url)))
let probeSeq = 0

/**
 * Load-time guards can only be tested by RE-LOADING the built module with a
 * constant pushed over the line. That needs a mutated copy of `lib/` — and the
 * one place it must never be written is `lib/` itself.
 *
 * ⛔ `lib/` IS THE DELIVERABLE AND `files` IS A WILDCARD.
 *
 * `package.json` ships `files: ["lib/**\/*.js", ...]`. That pattern is not a
 * list of names, so a scratch module dropped in `lib/` is not a scratch module
 * — it is a shipped file, and `package.test.mjs` packs the tarball from the
 * same directory while these probes are running. Under `node --test`'s
 * FILE-LEVEL concurrency the two overlap, and the overlap is wrong in both
 * directions:
 *   - false RED: a real run failed `package.test.mjs` with a stray entry
 *     `+ [ 'lib/tools.guardprobe-4162710.js' ]` — a probe mid-flight, no defect.
 *   - false GREEN: the same window can close before `npm pack` reads the
 *     directory, so a genuine leak goes unseen.
 * Neither is a scheduling accident to be tuned away; the write itself is the
 * defect. So every probe copy is a SIBLING of `lib/`, never a child.
 *
 * The check below is a WRITE-FACE guard: it runs at the write, on every call,
 * against the destination this call actually computed. A static check over the
 * test sources (`no test writes into lib/…` in `package.test.mjs`) covers the
 * other face — that no test names `lib/` as a destination outside this helper.
 *
 * BOTH are load-bearing, and that is measured, not assumed. Each catches a
 * mutant the other misses:
 *   - a probe that makes an EXTRA write straight to `libDir`: the static check
 *     names the offending line in this file, while this assertion fires 0
 *     times. Not because `dir` was bypassed — that mutant still builds `dir`,
 *     still copies to it and still imports from it, and all 5 of the tests that
 *     use this helper pass. The assertion is silent because `dir` is genuinely
 *     CORRECT; the leak is a second, additional write, and this assertion only
 *     ever sees the one destination it is handed.
 *   - a probe whose destination is COMPUTED (`['l','i','b'].join('')`) so the
 *     text check cannot read it: this assertion fails 5 of those tests while
 *     the static check reports 0 findings. Deleting this assertion revives that
 *     mutant to a fully green 310/310/0.
 *
 * Counts, since three different ones are easy to confuse: this helper has 6
 * textual call sites across 4 files, in 5 tests, and runs 7 times per suite —
 * `group.test.mjs` loops its site twice and adds an unmutated control. Measured
 * by instrumenting the helper: 7 invocations, and 5 tests fail when it throws.
 * A static check reads text; text can be right while a computed path is wrong.
 *
 * The probe dir is deliberately NOT added to `.gitignore`. Measured: the
 * repo's `packages/*\/lib/` rule does not match `lib-probe-*`
 * (`git check-ignore` exits 1; `git status` shows `?? packages/memory/lib-probe-…`).
 * A leftover from a crashed run SHOULD be visible — hiding it would turn a
 * cleanup failure into a silent one.
 *
 * @param file    module inside `lib/` to rewrite, e.g. `'constants.js'`
 * @param mutate  `(source) => patched`, or `null` for an UNMUTATED copy — the
 *                control case, which must go through this same machinery or it
 *                is not controlling for the machinery.
 * @param use     receives `{ dir, url }`; `url(m = file)` is the absolute
 *                `file://` href of module `m` inside the copy, so a test can
 *                mutate `constants.js` and import `tools.js` from that copy.
 */
export const withLibProbe = async ({ file, mutate }, use) => {
  const libDir = join(PKG_ROOT_PROBE, 'lib')
  const source = readFileSync(join(libDir, file), 'utf8')
  const patched = mutate === null ? source : mutate(source)
  // A probe whose rewrite silently missed would assert nothing at all: the
  // copy would load cleanly and "no throw" would read as "guard absent".
  if (mutate !== null) {
    assert.notEqual(patched, source, `the probe must actually rewrite ${file}`)
  }

  // A SIBLING of lib/ inside the package root, so `node_modules` still
  // resolves upward from the copy and the module's relative imports resolve.
  // pid + sequence: `node --test` runs files in separate processes, and one
  // file may hold two probes at once.
  const dir = join(PKG_ROOT_PROBE, `lib-probe-${process.pid}-${probeSeq++}`)

  // WRITE-FACE GUARD. `relative()` then `startsWith('..')` rather than a string
  // prefix test: it is the containment question asked of RESOLVED paths, so a
  // sibling whose name merely starts with the same characters is not mistaken
  // for a child — `lib-probe-…` does begin with `lib`, and a raw
  // `startsWith(libDir)` would read it as inside. `lib/` itself relativises to
  // `''`, which fails both branches below and is rejected with the children.
  const rel = relative(libDir, resolve(dir))
  assert.ok(
    rel.startsWith('..') || isAbsolute(rel),
    `WRITE-FACE: withLibProbe would write into lib/ (${dir}). lib/ is the deliverable and ` +
      '`files: ["lib/**/*.js"]` is a WILDCARD, so anything written there is a shipped file ' +
      'and races package.test.mjs, which packs that same directory concurrently. The probe ' +
      'copy must be a SIBLING of lib/.',
  )

  cpSync(libDir, dir, { recursive: true })
  try {
    writeFileSync(join(dir, file), patched, 'utf8')
    return await use({
      dir,
      url: (m = file) => pathToFileURL(join(dir, m)).href,
    })
  } finally {
    // `finally`, so a failing assertion inside `use` still removes the copy.
    rmSync(dir, { recursive: true, force: true })
  }
}
