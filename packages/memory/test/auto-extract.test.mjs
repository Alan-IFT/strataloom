/** §10 enqueue gate + runner behavior. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService } from '../lib/service.js'
import { installAutoExtract } from '../lib/auto-extract.js'
import { JobRunner } from '../lib/pipeline/runner.js'
import { enqueueJob } from '../lib/pipeline/jobs.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import {
  openRegistry,
  cleanup,
  fakeAgent,
  fakeCtx,
  tempRoot,
  turnEvents,
  userMessageEvent,
  assistantMessageEvent,
} from './helpers.mjs'

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

/** ctx stub with an `on` bus the installer hooks into. */
const listeningCtx = (options) => {
  const ctx = fakeCtx(options)
  const listeners = new Map()
  ctx.on = (name, listener) => {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  }
  ctx.emitTurnStopping = (payload) => listeners.get('agent/turn-stopping')?.(payload)
  return ctx
}

const bigTurn = (turn) =>
  turnEvents(turn, [
    userMessageEvent('u'.repeat(500)),
    assistantMessageEvent(turn, 'a'.repeat(500)),
  ])

const smallTurn = (turn) => turnEvents(turn, [userMessageEvent('tiny')])

test('L0 capture is unconditional; only the extract enqueue is gated', () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo, events: bigTurn(1), options: {} })
  const small = fakeAgent({ id: 'sm', cwd: repo, events: smallTurn(2) })
  const subagent = fakeAgent({ id: 's', cwd: repo, origin: 'subagent', delegationDepth: 1, events: bigTurn(3) })

  // 1) No `llm`: the conversation is STILL recorded — the durable record of
  //    what was said must not depend on wanting to extract from it.
  const noLlm = listeningCtx({ agents: [principal] })
  installAutoExtract(noLlm, service(registry, noLlm))
  noLlm.emitTurnStopping({ agent: principal, turn: 1, signal: new AbortController().signal })
  const store = registry.all()[0]
  assert.ok(store, 'store opened for capture')
  assert.ok(
    store.db.prepare(`SELECT count(*) c FROM conversations`).get().c > 0,
    'L0 captured without llm',
  )
  assert.equal(store.db.prepare(`SELECT count(*) c FROM jobs`).get().c, 0, 'but no extract job')

  // 2) With `llm`: a big principal turn enqueues exactly once (idempotent).
  const full = listeningCtx({
    agents: [principal, small, subagent],
    services: { llm: {} },
  })
  installAutoExtract(full, service(registry, full))
  full.emitTurnStopping({ agent: principal, turn: 1, signal: new AbortController().signal })
  full.emitTurnStopping({ agent: principal, turn: 1, signal: new AbortController().signal }) // dup absorbed
  assert.equal(store.db.prepare(`SELECT count(*) c FROM jobs`).get().c, 1)

  // 3) Small turn: captured (it is still conversation) but not extracted.
  full.emitTurnStopping({ agent: small, turn: 2, signal: new AbortController().signal })
  assert.equal(store.db.prepare(`SELECT count(*) c FROM jobs`).get().c, 1, 'below threshold')
  assert.ok(
    store.db.prepare(`SELECT count(*) c FROM conversations WHERE session_id = 'sm'`).get().c > 0,
    'small turn still recorded',
  )

  // 4) Subagent: neither captured nor extracted — not this repo's conversation.
  full.emitTurnStopping({ agent: subagent, turn: 3, signal: new AbortController().signal })
  assert.equal(store.db.prepare(`SELECT count(*) c FROM jobs`).get().c, 1)
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM conversations WHERE session_id = 's'`).get().c,
    0,
    'subagent turns are not captured',
  )

  // payload pins session/turn/route/versions
  const payload = JSON.parse(store.db.prepare(`SELECT payload FROM jobs`).get().payload)
  assert.equal(payload.sessionId, 'p')
  assert.equal(payload.turn, 1)
  assert.equal(payload.promptVersion, 1)
  registry.dispose()
  cleanup(root)
})

test('capture and enqueue commit together (a queued job always has its turn)', () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo, events: bigTurn(7) })
  const ctx = listeningCtx({ agents: [principal], services: { llm: {} } })
  installAutoExtract(ctx, service(registry, ctx))
  ctx.emitTurnStopping({ agent: principal, turn: 7, signal: new AbortController().signal })

  const store = registry.all()[0]
  const job = store.db.prepare(`SELECT payload FROM jobs`).get()
  const { sessionId, turn } = JSON.parse(job.payload)
  const rows = store.db
    .prepare(`SELECT count(*) c FROM conversations WHERE session_id = ? AND turn = ?`)
    .get(sessionId, turn)
  assert.ok(rows.c > 0, 'the queued turn is readable from L0')
  registry.dispose()
  cleanup(root)
})

test('runner: busy-skip costs no attempt; an empty turn settles as done', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  enqueueJob(store, 'extract', 'j1', { sessionId: 's', turn: 1, provider: 'p', model: 'm' }, 0)

  // busy ⇒ peek-skip (attempts untouched)
  let busy = true
  const ctx = fakeCtx({})
  const runner = new JobRunner(ctx, registry, () => busy)
  runner.tick()
  await runner.whenSettled()
  assert.equal(store.db.prepare(`SELECT attempts, state FROM jobs WHERE id = 'j1'`).get().attempts, 0)

  // Not busy ⇒ claimed. The job's turn has no L0 rows (nothing captured for
  // session 's'), which is a legitimate empty turn, not a failure: it settles
  // as done without burning an LLM call.
  busy = false
  runner.tick()
  await runner.whenSettled()
  const row = store.db.prepare(`SELECT attempts, state FROM jobs WHERE id = 'j1'`).get()
  assert.equal(row.attempts, 1)
  assert.equal(row.state, 'done', 'empty turn settles, it does not retry forever')

  // dispose stops claiming
  await runner.dispose()
  runner.tick()
  await runner.whenSettled()
  assert.equal(store.db.prepare(`SELECT attempts FROM jobs WHERE id = 'j1'`).get().attempts, 1)
  registry.dispose()
  cleanup(root)
})

test('runner: poisoned job dead-letters instead of running', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  enqueueJob(store, 'extract', 'j1', {}, 0)
  store.tx(() => {
    store.db.prepare(`UPDATE jobs SET attempts = 5 WHERE id = 'j1'`).run() // next claim = 6 > MAX
  })
  const runner = new JobRunner(fakeCtx({}), registry, () => false)
  runner.tick()
  await runner.whenSettled()
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get().state, 'failed')
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})
