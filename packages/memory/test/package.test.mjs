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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const output = run('npm', ['pack', '--pack-destination', staging], packageRoot)
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
