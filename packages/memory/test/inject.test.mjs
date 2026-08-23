/** §10 injection domain: audience, budget, freshness, discrete rules. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService } from '../lib/service.js'
import { buildContextProvider, renderFramed, FRAMING_HEADER } from '../lib/recall/inject.js'
import { queryInjectionRows } from '../lib/store/fts.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { openRegistry, cleanup, fakeAgent, fakeCtx, tempRoot } from './helpers.mjs'

const makeRepo = () => {
  const dir = join(tempRoot(), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const service = (registry, ctx) => {
  const svc = Reflect.construct(function () {}, [])
  Object.setPrototypeOf(svc, MemoryService.prototype)
  svc.ctx = ctx
  svc.stores = registry
  return svc
}

const insert = (store, { id, status = 'active', provenance = 'human', title = 't', body = 'b', updatedAt = 0 }) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES (?, 'fact', 'repo-local', ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, status, title, body, provenance, updatedAt)

test('discrete rules: only active + injectable provenance rows enter the packet, priority-ordered', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    insert(store, { id: 'h', provenance: 'human', updatedAt: 1 })
    insert(store, { id: 'pe', provenance: 'principal-explicit', updatedAt: 9 })
    insert(store, { id: 'pa', provenance: 'parent-agent', updatedAt: 9 })
    insert(store, { id: 'sub', provenance: 'subagent', updatedAt: 99 }) // never injected
    insert(store, { id: 'tool', provenance: 'tool-output', updatedAt: 99 }) // never injected
    insert(store, { id: 'cand', provenance: 'human', status: 'candidate' }) // excluded status
    insert(store, { id: 'tomb', provenance: 'human', status: 'tombstone' })
  })
  const rows = queryInjectionRows(store)
  assert.deepEqual(rows.map((r) => r.id), ['h', 'pe', 'pa'])
  registry.dispose()
  cleanup(root)
})

test('audience: subagent and depth-bearing agents get empty injection; principal gets the packet', () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo })
  const subagent = fakeAgent({ id: 's', cwd: repo, origin: 'subagent', delegationDepth: 1 })
  const ctx = fakeCtx({ agents: [principal, subagent] })
  const svc = service(registry, ctx)
  // open the store via a propose-equivalent path: direct open by derived key
  const store = svc.storeFor(principal, true)
  store.tx(() => insert(store, { id: 'm1', title: 'pnpm', body: 'use pnpm' }))

  const provider = buildContextProvider(ctx, svc)
  assert.match(provider({ agent: principal }), /pnpm/)
  assert.equal(provider({ agent: subagent }), '')
  assert.equal(provider({}), '') // no agent (diagnostics assembly)
  registry.dispose()
  cleanup(root)
})

test('unopened store or store failure ⇒ empty injection (never opens, never throws)', () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo })
  const noCwd = fakeAgent({ id: 'n' })
  const ctx = fakeCtx({ agents: [principal, noCwd] })
  const svc = service(registry, ctx)
  const provider = buildContextProvider(ctx, svc)
  // Store never opened: injection must NOT open it (hot path) — empty.
  assert.equal(provider({ agent: principal }), '')
  assert.equal(registry.all().length, 0)
  assert.equal(provider({ agent: noCwd }), '')
  // Failure path: a service whose storeFor throws must yield '' too.
  const exploding = service(registry, ctx)
  exploding.storeFor = () => {
    throw new Error('boom')
  }
  assert.equal(buildContextProvider(ctx, exploding)({ agent: principal }), '')
  registry.dispose()
  cleanup(root)
})

test('budget: oversized entries are skipped, header only appears with content', () => {
  const rows = [
    { id: 'a', kind: 'fact', title: 'huge', body: 'x'.repeat(20_000) }, // over budget alone
    { id: 'b', kind: 'fact', title: 'small', body: 'fits fine' },
  ]
  const packet = renderFramed(rows, 1_300)
  assert.match(packet, /small/)
  assert.doesNotMatch(packet, /xxxxx/, 'an oversized entry is skipped...')
  assert.ok(packet.startsWith(FRAMING_HEADER))
  assert.equal(renderFramed([], 1_300), '')
  // all-skipped ⇒ '' (never a lone framing header)
  assert.equal(renderFramed([rows[0]], 1_300), '')
})

test('a full packet stays within the §4.2 total budget (header included)', () => {
  // 40 entries is twice INJECT_TOP_N, so the budget — not the row cap — is
  // what bounds this. The spec's ceiling is header + body ≤ 1400 tokens.
  const hits = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    kind: 'fact',
    title: `memory number ${i}`,
    body: 'a reasonably typical memory body '.repeat(6),
  }))
  const packet = renderFramed(hits, 1_300)
  assert.ok(packet.length > 0)
  assert.ok(
    Math.ceil(packet.length / 4) <= 1_400,
    `packet must fit the total budget, got ~${Math.ceil(packet.length / 4)} tokens`,
  )
})

test('both read exits share one renderer: same framing, ids only for recall', () => {
  const hits = [{ id: 'm1', kind: 'fact', title: 't', body: 'b' }]
  const injected = renderFramed(hits, 1_300) // injection: no ids
  const recalled = renderFramed(hits, 500, true) // recall tool: ids for forget
  assert.ok(injected.startsWith(FRAMING_HEADER))
  assert.ok(recalled.startsWith(FRAMING_HEADER), 'the tool exit is framed too')
  assert.doesNotMatch(injected, /m1/)
  assert.match(recalled, /\(id m1\)/)
})

test('commit ⇒ next assemble sees it (forget closes injection immediately)', async () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo })
  const ctx = fakeCtx({ agents: [principal] })
  const svc = service(registry, ctx)
  const provider = buildContextProvider(ctx, svc)

  const { id } = await svc.propose({ title: 'ephemeral', body: 'now you see me', kind: 'fact' }, principal)
  assert.match(provider({ agent: principal }), /ephemeral/)
  await svc.forget(id, principal)
  assert.equal(provider({ agent: principal }), '') // D5: literal immediacy
  registry.dispose()
  cleanup(root)
})

test('cross-process freshness: a write from another OS process is visible to the open reader (WAL)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const dbPath = join(root, 'repos', 'k1', 'memory.sqlite')
  const child = spawnSync(process.execPath, [
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at) VALUES ('xp', 'fact', 'repo-local', 'active', 'from other process', 'body', 'human', 0, 0)");
    db.exec("COMMIT");
    db.close();
    `,
  ])
  assert.equal(child.status, 0, String(child.stderr))
  const rows = queryInjectionRows(store)
  assert.deepEqual(rows.map((r) => r.id), ['xp'])
  registry.dispose()
  cleanup(root)
})
