/**
 * Packaging contract: what `npm pack` produces must be loadable by NAME from
 * a real dependency install. A plugin that only works from its source tree is
 * not a deliverable, and that failure mode is invisible to every other test
 * here — they all import through relative paths.
 *
 * Skipped automatically when `npm pack` cannot run (offline/sandboxed CI).
 *
 * This file owns BOTH faces of one rule about `lib/`:
 *   - the SHIP face (first test): nothing reaches the tarball that `tsc` did
 *     not put there. It reads the packed output, so it needs `npm pack`.
 *   - the WRITE face (second test): no test names `lib/` as a write
 *     DESTINATION. It reads the test sources off disk, so it needs nothing and
 *     is deliberately a SEPARATE `test()` — folding it into the first would
 *     make it vanish down that test's `t.skip` paths, and a guard that
 *     disappears exactly when the environment is degraded is not a guard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'strataloom-npm-cache') },
  })

test('the packed tarball installs and loads by package name', async (t) => {
  let tarball
  const staging = mkdtempSync(join(tmpdir(), 'strataloom-pack-'))
  try {
    // `--ignore-scripts` is what makes this test read the deliverable instead
    // of manufacturing one. Without it npm fires `prepare: tsc`, which rewrites
    // `lib/**/*.js` IN PLACE, and that has two measured consequences:
    //   (a) a corrupt `lib/` is repaired mid-test, so the one test that treats
    //       `lib/` as a shippable artifact can never fail. Measured: rename
    //       `apply` -> `apply_BROKEN` in `lib/index.js` with `src/` clean, and
    //       the deliverable really is broken (`typeof m.apply === 'undefined'`)
    //       — yet this test read `pass 1 fail 0` and the mutant was gone after
    //       the run. With the flag: `pass 0 fail 1`, mutant still present.
    //   (b) it rewrites modules that other test files are importing right now,
    //       under `node --test`'s file-level concurrency. Measured: a marker
    //       appended to `lib/store/group.js` was reverted in 7/7 trials.
    // Residual gap, stated so nobody reads more into the flag than it gives:
    // this packs whatever `lib/` currently holds, so a STALE `lib/` ships.
    // Measured: appending bytes to `lib/index.js` puts them in the tarball.
    // Freshness comes from the build preceding the tests (`npm run verify` is
    // `tsc && node --test`, and `scripts/release.sh` runs it before packing),
    // not from this flag.
    const output = run('npm', ['pack', '--ignore-scripts', '--pack-destination', staging], packageRoot)
    tarball = join(staging, output.trim().split('\n').at(-1))
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    t.skip(`npm pack unavailable: ${error.message.split('\n')[0]}`)
    return
  }

  try {
    // The tarball must carry the built artifacts and NOT the sources/tests.
    const listing = run('tar', ['-tzf', tarball], staging)
    assert.match(listing, /package\/lib\/index\.js/)
    assert.match(listing, /package\/lib\/types\/index\.d\.ts/)
    assert.match(listing, /package\/cordis\.patch\.yml/, 'the bundle patch must ship')
    assert.doesNotMatch(listing, /package\/src\//, 'sources must not ship')
    assert.doesNotMatch(listing, /package\/test\//, 'tests must not ship')

    // Nothing ships out of `lib/` that the compiler did not put there.
    //
    // `files` is `lib/**/*.js`, a WILDCARD, so anything a test drops in `lib/`
    // is a shipped file. Four scratch-module write sites across three test files
    // currently do that — guidance.test.mjs:50, layers.test.mjs:~3687, and
    // pipeline-e2e.test.mjs:~391 and ~457 (two sites in that one file) — and a
    // leak was measured as 63 entries against a 59 baseline.
    //
    // The rule is a PROPERTY, not the four probe names: `tsc` with
    // `rootDir: src` / `outDir: lib` / `declarationDir: lib/types` and no
    // source maps emits exactly one `.js` and one `.d.ts` per source, so the
    // packed set must be the compiler's inputs, mapped. A name list would go
    // stale the moment a fifth probe is written under a fifth name.
    //
    // This is deliberately two-way. Extra => a scratch file (or an orphan left
    // by a deleted source, since `tsc` never removes stale outputs) is about to
    // ship. Missing => `lib/` does not even contain one output per source. The
    // missing direction is a floor, NOT a freshness check: it compares file
    // NAMES, so a `lib/` whose contents are stale but complete still passes.
    const sources = readdirSync(join(packageRoot, 'src'), { recursive: true })
      .map(String)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))
      .map((p) => p.slice(0, -3).replaceAll('\\', '/'))
    assert.ok(sources.length > 0, 'the probe must find the sources it maps from')

    const expected = new Set(sources.flatMap((s) => [`lib/${s}.js`, `lib/types/${s}.d.ts`]))
    const packedLib = listing
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^package\//, ''))
      .filter((p) => p.startsWith('lib/'))

    const stray = packedLib.filter((p) => !expected.has(p))
    assert.deepEqual(
      stray,
      [],
      'the tarball carries files under lib/ that no source compiles to. Either a ' +
        'test scratch/probe module is about to be published to users, or a source ' +
        'was deleted and tsc left its output behind',
    )
    const missing = [...expected].filter((p) => !packedLib.includes(p))
    assert.deepEqual(missing, [], 'every source must have a built output in the tarball')

    // Install it the way a profile does, then resolve it BY NAME.
    const profile = join(staging, 'profile')
    run('mkdir', ['-p', profile], staging)
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-packtest',
        private: true,
        dependencies: { '@strataloom/dsh-memory': `file:${tarball}` },
      }),
    )
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    try {
      run('pnpm', ['install', '--ignore-scripts'], profile)
    } catch (error) {
      t.skip(`pnpm install unavailable: ${error.message.split('\n')[0]}`)
      return
    }

    // A real profile resolves peers from the ambient dsh installation; mirror
    // that by linking the same `@deepseek-ai` scope this test process uses.
    // .../@deepseek-ai/cordis/lib/index.js -> .../@deepseek-ai
    const peerScope = dirname(
      dirname(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis')))),
    )
    try {
      run('ln', ['-sfn', peerScope, join(profile, 'node_modules', '@deepseek-ai')], profile)
    } catch {
      t.skip('peer scope not linkable in this environment')
      return
    }

    const installed = join(profile, 'node_modules', '@strataloom', 'dsh-memory')
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.name, '@strataloom/dsh-memory')
    assert.equal(manifest.main, 'lib/index.js')

    const entry = await import(join(installed, 'lib', 'index.js'))
    assert.equal(typeof entry.apply, 'function')
    assert.deepEqual(entry.inject, ['tools', 'systemPrompt', 'agents', 'timer'])
    assert.equal(entry.name, 'strataloom-memory')

    // The bundle contract: `dsh plugin add` registers any dependency that
    // declares `dsh.bundle`, and applies the patch it points at. Without
    // both halves the user has to hand-edit the profile, so both are
    // asserted here rather than trusted to a README.
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    const patch = readFileSync(join(installed, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: strataloom-memory/)
    assert.match(patch, /name: '@strataloom\/dsh-memory'/)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ write face ----

/**
 * THE WRITER TABLE. Every entry carries BOTH halves of what the check needs:
 * `dest`, the argument index that names the thing the call CREATES, and
 * `probe`, the argument list that the self-test feeds through the predicate to
 * prove this row works.
 *
 * The two are deliberately in one place. A previous shape kept the writer names
 * in a list and the non-zero indices in a separate `DEST_INDEX` object, and the
 * two drifted immediately: `symlinkSync` and `linkSync` were added to the list
 * and never to the index, so the check read their SOURCE argument and was wrong
 * in BOTH directions — it missed a real symlink into `lib/` and simultaneously
 * fired on correct code that links FROM `lib/`. Measured, on that shape (the
 * two calls are DESCRIBED rather than written out: this file is one of the
 * sources the check scans, so a literal example here is itself a finding):
 *   symlink whose DESTINATION is a path into lib/ -> []         (missed)
 *   symlink whose SOURCE is lib/, dest elsewhere  -> 1 finding  (false positive)
 * Node's own semantics settle the index — both create the entry at argument 1:
 *   `symlinkSync(target, PATH)`   PATH exists afterwards, isSymlink true
 *   `linkSync(existing, NEWPATH)` NEWPATH exists afterwards
 *
 * `probe` is what removes the possibility of that drift returning. The
 * self-test iterates THIS table, so a row with no probe, or a row whose probe
 * does not round-trip through the predicate, fails loudly. Adding writer #13
 * without a fixture is not something a reviewer has to notice.
 *
 * `probe.args` is written from the CREATING call's point of view: `LIB` marks
 * where a path into `lib/` goes. The self-test builds two cases from each row —
 * one with `LIB` in the `dest` position (must be reported) and, for rows whose
 * `dest` is not 0, one with `LIB` in the source position (must stay silent,
 * because reading FROM `lib/` is exactly what `withLibProbe` legitimately does).
 */
const WRITER_TABLE = [
  { name: 'writeFileSync', dest: 0, probe: { args: ['LIB', "'x'"] } },
  { name: 'appendFileSync', dest: 0, probe: { args: ['LIB', "'x'"] } },
  { name: 'mkdirSync', dest: 0, probe: { args: ['LIB'] } },
  { name: 'mkdtempSync', dest: 0, probe: { args: ['LIB'] } },
  { name: 'rmSync', dest: 0, probe: { args: ['LIB'] } },
  { name: 'unlinkSync', dest: 0, probe: { args: ['LIB'] } },
  { name: 'createWriteStream', dest: 0, probe: { args: ['LIB'] } },
  { name: 'openSync', dest: 0, probe: { args: ['LIB', "'w'"] } },
  { name: 'cpSync', dest: 1, probe: { args: ['src', 'LIB'] } },
  { name: 'copyFileSync', dest: 1, probe: { args: ['src', 'LIB'] } },
  { name: 'renameSync', dest: 1, probe: { args: ['src', 'LIB'] } },
  { name: 'symlinkSync', dest: 1, probe: { args: ['target', 'LIB'] } },
  { name: 'linkSync', dest: 1, probe: { args: ['existing', 'LIB'] } },
]

const WRITERS = WRITER_TABLE.map((w) => w.name)
const DEST_INDEX = Object.fromEntries(WRITER_TABLE.map((w) => [w.name, w.dest]))

/** Split a call's arguments on TOP-LEVEL commas, respecting nesting and quotes. */
const splitArgs = (s) => {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      cur += c
      if (c === quote && s[i - 1] !== '\\') quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      cur += c
      continue
    }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) {
      if (depth === 0) break
      depth--
    }
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out.map((a) => a.trim())
}

/**
 * A literal naming lib/: the bare segment `lib` as a join() component, or any
 * string carrying a `/lib/` path segment. Backticks are accepted alongside
 * quotes — `` join(root, `lib`, 'p.js') `` is the same destination written a
 * different way, and reading only `'`/`"` here was measured to miss it silently.
 */
const namesLibLiteral = (t) =>
  /(^|[^\w$.])['"`]lib['"`]\s*[,)]/.test(t) || /['"`][^'"`]*\/lib(\/|['"`])/.test(t)

/**
 * Identifiers in a file that hold a path to lib/, to a fixpoint, so an alias
 * chain (`const libDir = join(root,'lib')` -> `const p = join(libDir, x)`) is
 * followed. Only PATH-SHAPED right-hand sides propagate — an RHS that merely
 * mentions such an identifier (file CONTENTS read from it, a `relative()`
 * result) is not itself a path, and treating it as one is how a static check
 * starts firing on correct code. String CONCATENATION counts as path-shaped:
 * `libDir + '/probe.js'` is a destination, and it was measured to slip through
 * when only `join(`/`resolve(`/literal openers were accepted.
 */
const libAliases = (src) => {
  const decls = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]+)/g)]
  const ids = new Set()
  for (let grew = true; grew; ) {
    grew = false
    for (const [, name, rhs] of decls) {
      if (ids.has(name)) continue
      const pathShaped =
        /^\s*(?:join|resolve)\s*\(/.test(rhs) || /^\s*[`'"]/.test(rhs) || /^\s*[A-Za-z_$][\w$]*\s*\+/.test(rhs)
      if (!pathShaped) continue
      const hit =
        namesLibLiteral(rhs) ||
        [...ids].some((id) => new RegExp(`(^|[^\\w$.])${id}([^\\w$]|$)`).test(rhs))
      if (hit) {
        ids.add(name)
        grew = true
      }
    }
  }
  return ids
}

/**
 * THE PREDICATE. One implementation, shared by the real check and by the
 * dirty-fixture self-test below — deliberately, because two copies of a rule
 * is how the copy that is not exercised goes quietly wrong.
 *
 * Takes `{ name, src }` pairs rather than reading a directory, so a caller can
 * hand it a fixture that exists only in memory.
 */
const libWriteFindings = (files) => {
  const findings = []
  for (const { name, src } of files) {
    const aliases = libAliases(src)
    const namesLib = (t) =>
      namesLibLiteral(t) ||
      [...aliases].some((id) => new RegExp(`(^|[^\\w$.])${id}([^\\w$]|$)`).test(t))

    for (const writer of WRITERS) {
      for (const m of src.matchAll(new RegExp(`\\b${writer}\\s*\\(`, 'g'))) {
        const dest = splitArgs(src.slice(m.index + m[0].length))[DEST_INDEX[writer] ?? 0]
        if (!dest || !namesLib(dest)) continue
        findings.push(`${name}:${src.slice(0, m.index).split('\n').length} ${writer}(… ${dest} …)`)
      }
    }
  }
  return findings
}

/**
 * The completeness criterion, stated as the rule and not as a list of names:
 *
 *   NO TEST FILE MAY NAME `lib/` AS A WRITE DESTINATION, EXCEPT THROUGH
 *   `withLibProbe` IN `helpers.mjs`.
 *
 * The test above is the ship face and it is NOT sufficient on its own.
 * Measured: with the probe helper re-broken so it also writes into `lib/`,
 * three trials of the full suite read `309 pass / 0 fail` — `npm pack` simply
 * did not overlap the window. The ship face samples a moment; the write face is
 * a property of the source, so it is checked in the source.
 *
 * WHY DESTINATION-AWARE, AND NOT A GREP FOR `lib`.
 * A grep for the identifier is measurably the wrong net in both directions.
 * Measured against the pre-fix tree, a naive `libDir` grep fires on
 * `cpSync(libDir, dir)` — where `libDir` is the SOURCE being copied FROM, which
 * is correct code and the one thing `withLibProbe` must keep doing — and it
 * still misses a probe written through an intermediate variable. So this reads
 * the ARGUMENT POSITION that is actually a destination, per the writer table:
 * index 1 for the calls that take a source THEN a destination, index 0 for the
 * rest. Verified on three trees: 8 findings on the pre-fix sources, 1 on a
 * helper mutated to write into `lib/`, 0 on this tree.
 *
 * RESIDUAL GAP, stated plainly. This is a TEXT check, not an evaluator, and the
 * list below is what it does NOT cover — not a claim to be exhaustive.
 *
 * DESTINATION side:
 *   - A destination it cannot read statically — a computed segment such as
 *     `['l','i','b'].join('')`, a helper imported from another module, a path
 *     assembled at runtime — is invisible to it. MEASURED: a probe using that
 *     computed form scored 0 findings here while the at-the-write assertion in
 *     `withLibProbe` fired on every call. That is why both exist; neither
 *     subsumes the other.
 *
 * WRITER side — all MEASURED as missed, with plainly readable destinations:
 *   - the async APIs (`fs.promises.writeFile`, or `writeFile` imported from
 *     `node:fs/promises`);
 *   - writer aliasing (`const wf = writeFileSync` and then calling `wf`);
 *   - shelling out (`execFileSync('cp', [src, dest])`).
 *   Latent rather than live: this tree is sync-only today — 14 imports from
 *   `node:fs`, 0 from `node:fs/promises`, 0 uses of `fs.promises`. The first
 *   contributor to write an async test defeats this check silently.
 *
 * THIS TEST ITSELF is the weakest link, and it is not closable from inside.
 * The predicate's completeness rests on the self-test below; the self-test is
 * guarded by nothing. MEASURED: a real leak in the tree, plus deleting the
 * self-test, plus gutting `libAliases`, reads `pass 2 / fail 0` — fully green.
 * The self-test kills the mutants that reach the predicate, but a mutation that
 * removes the self-test takes its own guard with it.
 *
 * SCOPE: it reads the `test/` sources only, and judges TEXT, not intent — a
 * legitimate `lib/` built inside a temp fixture or a staged install would be
 * reported. That is closer than "nothing does that today" suggests: the packing
 * test above already stages an install into a temp dir, and is silent only
 * because it never names `lib/` as a destination. One natural extension of it
 * fires this check on correct code. The fix then is to teach the predicate
 * about that root, not to weaken the destination rule.
 */
test('no test writes into lib/, the deliverable, except through withLibProbe', () => {
  // ---- negative control FIRST: the predicate must bite on a dirty tree ----
  //
  // Without this, every reading below is taken against a tree that is clean BY
  // CONSTRUCTION, and a predicate that had been gutted would still be green.
  // Measured, before this control existed: replacing `libAliases` with
  // `() => new Set()` (19 lines deleted) took the pre-fix tree from 8 findings
  // to 0, and shrinking the writer list to `['writeFileSync']` took it from 8
  // to 4 — both fully green. A guard with no negative control is the same
  // defect this test exists to remove, one level up.
  //
  // The fixtures are ASSEMBLED from parts, never spelled out as literal call
  // text. This file is itself one of the sources the real check scans, so a
  // literal write-into-lib call written here — even inside a comment — is
  // indistinguishable from the real thing and gets reported. Measured twice:
  // one draft spelled the calls out and the real check reported all three
  // (`package.test.mjs:357/364/365`); another left them in a comment alone and
  // it reported that too (`:351`). Assembling keeps the fixtures dirty for the
  // predicate while this file stays clean for the rule — and both catches are
  // themselves evidence the check bites.
  const W = (fn, ...args) => `${fn}(${args.join(', ')})`
  const LIB = "'lib'"
  const intoLib = "join(libDir, 'p')"
  const decl = `const libDir = join(root, ${LIB})`

  // MEMBERSHIP IS PINNED INDEPENDENTLY OF THE TABLE.
  //
  // Iterating the table proves every row WORKS; it cannot prove the table is
  // COMPLETE, because deleting a row also deletes its own case from the loop.
  // That is measured, not hypothetical, and it is why this list exists: with
  // the loop alone, 12 of 13 rows could be deleted with the suite fully green
  // (only `writeFileSync` failed, and only because other assertions happen to
  // use it). A self-referential check certifies whatever it is handed — the
  // same shape as the vacuous guards this whole round exists to remove.
  //
  // So the expected names are written out ONCE, here, as a literal that a
  // deletion must contradict. Adding writer #14 means updating this list AND
  // giving it a probe row; forgetting either one is red.
  //
  // The names below are inert strings inside a comparison, never calls, so the
  // real check does not read them as write destinations.
  assert.deepEqual(
    WRITER_TABLE.map((w) => `${w.name}@${w.dest}`).sort(),
    [
      'appendFileSync@0',
      'copyFileSync@1',
      'cpSync@1',
      'createWriteStream@0',
      'linkSync@1',
      'mkdirSync@0',
      'mkdtempSync@0',
      'openSync@0',
      'renameSync@1',
      'rmSync@0',
      'symlinkSync@1',
      'unlinkSync@0',
      'writeFileSync@0',
    ],
    'the writer table changed. Every entry needs a destination INDEX matching the ' +
      'argument the call creates (the two link writers create argument 1, not 0 — ' +
      'getting that backwards made the check miss real leaks AND fire on correct code) ' +
      'and a probe case below. Update this list deliberately, not to clear a red.',
  )

  // TABLE-DRIVEN, over the writer table itself: every row must round-trip
  // through the predicate in both directions. Together with the membership
  // assertion above, adding a writer without a fixture and deleting one
  // quietly are both red.
  for (const { name, dest, probe } of WRITER_TABLE) {
    assert.ok(probe && Array.isArray(probe.args), `${name}: the writer table row must carry a probe`)
    assert.ok(probe.args.includes('LIB'), `${name}: the probe must mark where the lib/ path goes`)
    assert.equal(
      probe.args.indexOf('LIB'),
      dest,
      `${name}: the probe must place the lib/ path in the destination position it declares`,
    )

    // DIRECTION 1 — a real write INTO lib/ must be reported.
    const leakSrc = [decl, W(name, ...probe.args.map((a) => (a === 'LIB' ? intoLib : a)))].join('\n')
    const leak = libWriteFindings([{ name: `fixture-${name}.mjs`, src: leakSrc }])
    assert.ok(
      leak.some((f) => f.startsWith(`fixture-${name}.mjs:2 ${name}`)),
      `${name}: a write INTO lib/ must be reported; got ${JSON.stringify(leak)}`,
    )

    // DIRECTION 2 — for the two-path writers, naming lib/ as the SOURCE is
    // correct code and must stay silent. This is the half that was measurably
    // wrong for symlinkSync/linkSync: it fired on code that links FROM lib/.
    if (dest !== 0) {
      const okArgs = [...probe.args]
      okArgs[0] = 'libDir'
      okArgs[dest] = 'elsewhere'
      const ok = libWriteFindings([
        { name: `fixture-${name}-src.mjs`, src: [decl, W(name, ...okArgs)].join('\n') },
      ])
      assert.deepEqual(
        ok,
        [],
        `${name}: reading FROM lib/ is what withLibProbe legitimately does; it must not be reported`,
      )
    }
  }

  // Alias chains, separately: the destination is reached two hops from the
  // literal (root -> libDir -> nested), which is what `libAliases` exists for.
  const aliasFindings = libWriteFindings([
    {
      name: 'fixture-alias.mjs',
      src: [
        `const root = join(import.meta.dirname, '..')`,
        decl,
        `const nested = join(libDir, 'probe.js')`,
        W('writeFileSync', 'nested', "'x'"),
      ].join('\n'),
    },
  ])
  assert.ok(
    aliasFindings.some((f) => f.startsWith('fixture-alias.mjs:4 writeFileSync')),
    `the predicate must follow an alias chain into lib/; got ${JSON.stringify(aliasFindings)}`,
  )

  // ---- the real check, now that the predicate is known to bite ----
  const testDir = join(packageRoot, 'test')
  const names = readdirSync(testDir)
    .map(String)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
  assert.ok(names.length > 0, 'the check must find the test sources it scans')

  // A SENTINEL is scanned alongside the real sources, and the expectation is
  // the sentinel's own finding rather than `[]`. So this assertion states a
  // POSITIVE fact — "the scan produced exactly this known entry" — and an
  // expectation that has been emptied or dropped is RED rather than vacuous.
  // Measured: replacing the expected value with `[]` gives `pass 1 / fail 1`.
  //
  // What it does NOT close, stated plainly rather than smoothed over: mutating
  // BOTH sides to the same expression (`deepEqual(findings, findings)`) still
  // reads `pass 2 / fail 0` with a real leak in the tree. An equality whose two
  // sides are the same expression is true whatever the predicate returns, so no
  // assertion written inside this test can detect it. Catching that needs a
  // check from outside the file — mutation testing — which this repo does not
  // run today. The sentinel narrows the hole; it does not seal it.
  const SENTINEL = 'sentinel-known-dirty.mjs'
  const findings = libWriteFindings([
    ...names.map((name) => ({ name, src: readFileSync(join(testDir, name), 'utf8') })),
    { name: SENTINEL, src: [decl, W('writeFileSync', intoLib, "'x'")].join('\n') },
  ])

  // Built with the same `W` helper as the fixtures, for the same reason: a
  // literal `writeFileSync(… )` spelled out here would be a finding in this
  // file. Measured — an earlier draft wrote it out and the check reported
  // `package.test.mjs:508`.
  assert.deepEqual(
    findings,
    [`${SENTINEL}:2 ${W('writeFileSync', `… ${intoLib} …`)}`],
    'a test names lib/ as a WRITE DESTINATION. lib/ is the deliverable and `files` is the ' +
      'wildcard "lib/**/*.js", so a scratch module written there is a shipped file, and it ' +
      'races the packing test in this same file under node --test\'s file-level ' +
      'concurrency — measured once as a false RED (`+ [ \'lib/tools.guardprobe-4162710.js\' ]`) ' +
      'and capable of a false GREEN in the other direction. Use withLibProbe from ' +
      'helpers.mjs, which copies lib/ to a SIBLING directory and asserts that at the write. ' +
      `(The one expected entry is this test's own sentinel, ${SENTINEL}, which is not a ` +
      'real file; anything else in this list is a real test source naming lib/ as a ' +
      'destination. If ONLY the sentinel is missing, the check has stopped running.)',
  )
})
