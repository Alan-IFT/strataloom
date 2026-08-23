/** §10 closed-loop, API boundary, and forget domains. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService, MemoryAccessError, MemoryInputError } from '../lib/service.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { openRegistry, cleanup, fakeAgent, fakeCtx, tempRoot } from './helpers.mjs'

/** A real git repo (repo-key derivation shells out to git — D1 fact source). */
const makeRepo = () => {
  const dir = join(tempRoot(), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const setup = () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'principal', cwd: repo })
  const ctx = fakeCtx({ agents: [principal] })
  const service = Reflect.construct(function () {}, [])
  // Bypass cordis Service registration: construct via prototype so tests
  // need no cordis root. The class only uses this.ctx + this.stores.
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = ctx
  service.stores = registry
  return { repo, root, registry, principal, ctx, service }
}

test('closed loop: propose -> active -> recall -> forget, all synchronous', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'use pnpm not npm', body: 'this repo uses pnpm for everything', kind: 'fact' },
    principal,
  )
  // active immediately; recall finds it
  const found = await service.recall({ query: 'pnpm' }, principal)
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].id, id)

  // evidence row written in the same transaction (D3)
  const store = service.storeFor(principal, false)
  const evidence = store.db
    .prepare(`SELECT kind, ref FROM evidence WHERE memory_id = ?`)
    .all(id)
    .map((row) => ({ ...row }))
  assert.deepEqual(evidence, [{ kind: 'session', ref: 'principal' }])

  const report = await service.forget(id, principal)
  assert.equal(report.suppressedRefs, 1)
  assert.match(report.note, /not.*erased|outside this capability/i)

  // read surface closed at commit
  const after = await service.recall({ query: 'pnpm' }, principal)
  assert.equal(after.hits.length, 0)
  // title/body cleared, ref kept
  const row = store.db.prepare(`SELECT title, body, status FROM memories WHERE id = ?`).get(id)
  assert.deepEqual({ ...row }, { title: '', body: '', status: 'tombstone' })
  assert.equal(store.db.prepare(`SELECT count(*) c FROM evidence WHERE memory_id = ?`).get(id).c, 1)
  registry.dispose()
  cleanup(root)
})

test('forge rejection: an agent object not in the registry is refused', async () => {
  const { root, registry, principal, service } = setup()
  const forged = { ...principal } // same id, different object identity
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, forged),
    MemoryAccessError,
  )
  registry.dispose()
  cleanup(root)
})

test('lineage predicate: subagent-origin and resumed-depth agents are refused writes', async () => {
  const { root, registry, service, ctx, repo } = setup()
  const subagent = fakeAgent({ id: 'sub', cwd: repo, origin: 'subagent', delegationDepth: 1, parentSession: 'principal' })
  const resumedFormerSub = fakeAgent({ id: 'resumed', cwd: repo, delegationDepth: 1 }) // runtime root, durable depth
  const runtimeDeep = fakeAgent({ id: 'deep', cwd: repo, runtimeDepth: 2 }) // header clean, runtime depth
  for (const agent of [subagent, resumedFormerSub, runtimeDeep]) {
    ctx.agents.get(agent.id) // ensure map lookup path
  }
  // register them as live
  const live = fakeCtx({ agents: [subagent, resumedFormerSub, runtimeDeep] })
  service.ctx = live
  await assert.rejects(service.propose({ title: 't', body: 'b', kind: 'fact' }, subagent), /principal/)
  await assert.rejects(service.forget('x', resumedFormerSub), /principal/)
  await assert.rejects(service.propose({ title: 't', body: 'b', kind: 'fact' }, runtimeDeep), /principal/)
  registry.dispose()
  cleanup(root)
})

test('ordinary user fork (parentSession, no origin/depth) IS principal — misfire regression', async () => {
  const { root, registry, service, repo } = setup()
  const fork = fakeAgent({ id: 'fork', cwd: repo, parentSession: 'older-session' })
  service.ctx = fakeCtx({ agents: [fork] })
  const { id } = await service.propose({ title: 't', body: 'b', kind: 'fact' }, fork)
  assert.ok(id)
  registry.dispose()
  cleanup(root)
})

test('no cwd or non-git cwd: writes refused, recall empty (never process.cwd())', async () => {
  const { root, registry, service } = setup()
  const nowhere = fakeAgent({ id: 'nowhere' }) // no cwd
  const outside = fakeAgent({ id: 'outside', cwd: tempRoot() }) // not a git tree
  service.ctx = fakeCtx({ agents: [nowhere, outside] })
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, nowhere),
    /no repo affiliation/,
  )
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, outside),
    /no repo affiliation/,
  )
  const result = await service.recall({ query: 'anything' }, nowhere)
  assert.deepEqual(result.hits, [])
  registry.dispose()
  cleanup(root)
})

test('candidate carries no visibility/provenance: unknown kinds and oversizes fail loud', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'visibility-smuggle' }, principal),
    MemoryInputError,
  )
  await assert.rejects(
    service.propose({ title: 'x'.repeat(300), body: 'b', kind: 'fact' }, principal),
    MemoryInputError,
  )
  registry.dispose()
  cleanup(root)
})

test('forget unknown/already-forgotten ids fail loud; usage table updates on recall', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(service.forget('ghost', principal), MemoryInputError)
  const { id } = await service.propose({ title: 'k8s deploy steps', body: 'run make deploy', kind: 'procedure' }, principal)
  await service.recall({ query: 'deploy' }, principal)
  const store = service.storeFor(principal, false)
  const usage = store.db.prepare(`SELECT retrieved FROM usage WHERE memory_id = ?`).get(id)
  assert.equal(usage.retrieved, 1)
  await service.forget(id, principal)
  await assert.rejects(service.forget(id, principal), /already forgotten/)
  registry.dispose()
  cleanup(root)
})

test('recall matches phrases, not FTS syntax (server-side MATCH construction)', async () => {
  const { root, registry, principal, service } = setup()
  await service.propose({ title: 'quote "handling"', body: 'AND OR NOT are plain words here', kind: 'fact' }, principal)
  // Raw FTS operators as user input must not throw or change semantics.
  const result = await service.recall({ query: 'AND OR NOT' }, principal)
  assert.equal(result.hits.length, 1)
  const quoted = await service.recall({ query: 'quote "handling"' }, principal)
  assert.equal(quoted.hits.length, 1)
  registry.dispose()
  cleanup(root)
})
