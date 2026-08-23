/** repo-key normalization unit tests (spec §2.1). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeRemoteUrl,
  deriveRepoIdentity,
  clearRepoIdentityMemo,
} from '../lib/store/repo-key.js'
import { tempRoot, cleanup } from './helpers.mjs'

test('remote URL normalization: credentials, .git, scp form, host case', () => {
  const canonical = 'github.com/acme/widget'
  for (const url of [
    'https://github.com/acme/widget.git',
    'https://user:token@github.com/acme/widget',
    'git@github.com:acme/widget.git',
    'ssh://git@GitHub.com/acme/widget/',
    'GIT@GITHUB.COM:acme/widget',
  ]) {
    assert.equal(normalizeRemoteUrl(url), canonical, url)
  }
  // path case is preserved (repos differing only by path case stay distinct)
  assert.notEqual(normalizeRemoteUrl('git@github.com:acme/Widget'), canonical)
})

test('same remote ⇒ same key across different checkouts; no remote ⇒ path-distinct', () => {
  clearRepoIdentityMemo()
  const base = tempRoot()
  const a = join(base, 'a')
  const b = join(base, 'b')
  for (const dir of [a, b]) {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: dir })
  }
  const ia = deriveRepoIdentity(a)
  const ib = deriveRepoIdentity(b)
  assert.equal(ia.key, ib.key)
  assert.equal(ia.source, 'remote:github.com/acme/widget')

  // remove the remotes: keys become path-derived and distinct
  clearRepoIdentityMemo()
  for (const dir of [a, b]) execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir })
  const pa = deriveRepoIdentity(a)
  const pb = deriveRepoIdentity(b)
  assert.notEqual(pa.key, pb.key)
  assert.ok(pa.source.startsWith('path:'))
  cleanup(base)
})

test('symlinked checkout resolves to the same key (realpath)', () => {
  clearRepoIdentityMemo()
  const base = tempRoot()
  const real = join(base, 'real')
  mkdirSync(real, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: real })
  const link = join(base, 'link')
  symlinkSync(real, link)
  const fromReal = deriveRepoIdentity(real)
  clearRepoIdentityMemo()
  const fromLink = deriveRepoIdentity(realpathSync(link))
  assert.equal(fromReal.key, fromLink.key)
  cleanup(base)
})

test('non-git cwd ⇒ undefined (no guessing)', () => {
  clearRepoIdentityMemo()
  const dir = tempRoot()
  assert.equal(deriveRepoIdentity(dir), undefined)
  cleanup(dir)
})
