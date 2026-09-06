/**
 * Packaging contract: what `npm pack` produces must be loadable by NAME from
 * a real dependency install. A plugin that only works from its source tree is
 * not a deliverable, and that failure mode is invisible to every other test
 * here — they all import through relative paths.
 *
 * Skipped automatically when `npm pack` cannot run (offline/sandboxed CI).
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
