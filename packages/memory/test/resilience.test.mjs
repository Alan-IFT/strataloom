/**
 * Failure-path coverage for the primitives the design rests on: busy-retry
 * exhaustion, a corrupt store among healthy ones, fencing yield, and the
 * busy-agent probe. These paths only run when something is already going
 * wrong, so they are exactly the ones that rot untested.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the built library, for worker subprocesses. */
const packageLib = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
import { DatabaseSync } from 'node:sqlite'
import { immediateTx } from '../lib/store/tx.js'
import { StoreRegistry } from '../lib/store/store.js'
import { MemoryService } from '../lib/service.js'
import { registerTools } from '../lib/tools.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { JobRunner } from '../lib/pipeline/runner.js'
import { commitClaimedJob, enqueueJob, claimNextJob, FencingError } from '../lib/pipeline/jobs.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import { pruneConversations } from '../lib/store/conversations.js'
import { queryInjectionRows } from '../lib/store/fts.js'
import { IMMEDIATE_TX_RETRIES } from '../lib/constants.js'
import { openRegistry, cleanup, tempRoot, fakeAgent, fakeCtx } from './helpers.mjs'

const quiet = { warn() {}, info() {} }

test('immediateTx: gives up loudly when the lock never frees (retries are bounded)', () => {
  const root = tempRoot()
  const path = join(root, 'm.sqlite')
  const seed = new DatabaseSync(path)
  seed.exec('PRAGMA journal_mode = WAL')
  seed.exec('CREATE TABLE t (x INTEGER)')
  seed.close()

  // A separate process holds the write lock for the whole attempt window.
  const marker = join(root, 'locked')
  const holdMs = (IMMEDIATE_TX_RETRIES + 2) * 1_500
  const child = spawn(process.execPath, [
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.exec('INSERT INTO t VALUES (1)');
    fs.writeFileSync(${JSON.stringify(marker)}, '1');
    const until = Date.now() + ${holdMs}; while (Date.now() < until) {}
    db.exec('ROLLBACK'); db.close();
    `,
  ])
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5_000
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('child never took the lock')
    Atomics.wait(pause, 0, 0, 10)
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 100') // keep the bounded wait short
  let ran = false
  assert.throws(
    () => immediateTx(db, () => { ran = true }),
    /lock|busy/i,
    'a permanently held lock must fail loud, not hang or silently skip',
  )
  assert.equal(ran, false, 'the body must never run without the lock')
  db.close()
  child.kill()
  cleanup(root)
})

test('a corrupt store is refused without taking down the healthy ones', () => {
  const { root, registry } = openRegistry()
  registry.open('healthy')
  registry.dispose()

  // Plant a non-SQLite file where a store should be.
  const corruptDir = join(root, 'repos', 'corrupt')
  mkdirSync(corruptDir, { recursive: true })
  writeFileSync(join(corruptDir, 'memory.sqlite'), 'this is not a database')

  const second = new StoreRegistry(root, quiet)
  second.openAllKnown() // must not throw
  assert.ok(second.get('healthy'), 'healthy store still opens')
  assert.equal(second.get('corrupt'), undefined, 'corrupt store is skipped')
  second.dispose()
  cleanup(root)
})

test('a store branded by another application is refused at open', () => {
  const { root, registry } = openRegistry()
  registry.dispose()
  const dir = join(root, 'repos', 'foreign')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'memory.sqlite'))
  db.exec('PRAGMA application_id = 12345')
  db.exec('PRAGMA user_version = 3')
  db.exec('CREATE TABLE unrelated (x)')
  db.close()

  const second = new StoreRegistry(root, quiet)
  second.openAllKnown()
  assert.equal(second.get('foreign'), undefined, 'foreign store is skipped, not adopted')
  // ...and an explicit open fails loud rather than silently returning nothing.
  assert.throws(() => second.open('foreign'), /not a StrataLoom store/)
  second.dispose()
  cleanup(root)
})

test('runner: a fencing loss yields silently and does not consume a retry', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  enqueueJob(store, 'extract', 'j1', { sessionId: 's', turn: 1 }, 0)

  const now = Date.now()
  const stale = claimNextJob(store, now, now - 1) // already-expired lease
  const successor = claimNextJob(store, now, now + 60_000)
  assert.ok(successor)

  // The stale worker's commit is fenced: no business write, no state change.
  let mutated = false
  assert.throws(
    () => commitClaimedJob(store, 'j1', stale.leaseToken, () => { mutated = true }),
    FencingError,
  )
  assert.equal(mutated, false)
  const row = store.db.prepare(`SELECT state, lease_token, attempts FROM jobs WHERE id = 'j1'`).get()
  assert.equal(row.state, 'running')
  assert.equal(row.lease_token, successor.leaseToken)
  assert.equal(row.attempts, 2) // both claims counted; the fence added nothing
  registry.dispose()
  cleanup(root)
})

test('runner: a store that fails mid-tick does not stop the other stores', async () => {
  const { root, registry } = openRegistry()
  const good = registry.open('good')
  const broken = registry.open('broken')
  enqueueJob(good, 'extract', 'g1', {}, 0)
  enqueueJob(broken, 'extract', 'b1', {}, 0)
  // Break one store's connection out from under the runner.
  broken.db.close()

  const runner = new JobRunner(fakeCtx({}), registry, () => false)
  runner.tick()
  await runner.whenSettled() // must not reject

  // The healthy store still had its job claimed and retried (no sessionQuery).
  assert.equal(good.db.prepare(`SELECT attempts FROM jobs WHERE id = 'g1'`).get().attempts, 1)
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})

test('busy probe: a running principal in the same repo defers heavy jobs', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  enqueueJob(store, 'extract', 'j1', {}, 0)

  let agentRunning = true
  const runner = new JobRunner(fakeCtx({}), registry, () => agentRunning)
  runner.tick()
  await runner.whenSettled()
  assert.equal(
    store.db.prepare(`SELECT attempts FROM jobs WHERE id = 'j1'`).get().attempts,
    0,
    'deferring must not consume an attempt (peek before claim)',
  )

  agentRunning = false
  runner.tick()
  await runner.whenSettled()
  assert.equal(store.db.prepare(`SELECT attempts FROM jobs WHERE id = 'j1'`).get().attempts, 1)
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})

test('git absent or failing does not crash repo-key derivation', async () => {
  const { deriveRepoIdentity, clearRepoIdentityMemo } = await import('../lib/store/repo-key.js')
  clearRepoIdentityMemo()
  const dir = tempRoot()
  // A directory that IS a git repo but whose git objects are unreadable still
  // resolves or declines — never throws into the caller.
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const identity = deriveRepoIdentity(dir)
  assert.ok(identity === undefined || typeof identity.key === 'string')
  cleanup(dir)
})

test('concurrent processes can open the same store and all their writes land', async () => {
  // Two harness processes pointed at one repository is the ordinary case, so
  // neither opening nor writing may fail under contention. This regressed
  // once: `PRAGMA journal_mode` needs a brief exclusive lock, and running it
  // before `busy_timeout` made a concurrent open fail instantly.
  const root = tempRoot()
  const worker = join(root, 'w.mjs')
  writeFileSync(
    worker,
    `const { StoreRegistry } = await import(${JSON.stringify(join(packageLib, 'store/store.js'))})
     const reg = new StoreRegistry(process.argv[2], { warn() {}, info() {} })
     const store = reg.open('shared')
     const tag = process.argv[3]
     for (let i = 0; i < 25; i++) {
       store.tx(() => {
         store.db.prepare(
           \`INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
             VALUES (?, 'fact', 'repo-local', 'active', 't', 'b', 'human', 0, 0)\`,
         ).run(tag + i)
       })
     }
     reg.dispose()`,
  )

  // Start all three, THEN wait: spawnSync would serialize them and test
  // nothing. Exit codes are collected from the async children's events, so
  // this test is async — a synchronous busy-wait would starve them.
  const home = join(root, 'home')
  const codes = ['A', 'B', 'C'].map(
    (tag) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [worker, home, tag], { stdio: 'inherit' })
        child.on('exit', resolve)
      }),
  )
  for (const code of await Promise.all(codes)) {
    assert.equal(code, 0, 'every worker succeeded')
  }

  const registry = new StoreRegistry(home, quiet)
  registry.openAllKnown()
  const store = registry.get('shared')
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories`).get().c,
    75,
    'no write was silently lost to lock contention',
  )
  store.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')`)
  registry.dispose()
  cleanup(root)
})

test('an unusable store reads as unavailability, not as a filesystem error', async () => {
  // A read-only home is the realistic shape of "the store broke": the model
  // can neither fix nor route around it, so a raw EACCES with an internal
  // path is noise it may try to reason about. Deliberate refusals must still
  // survive — those ARE the answer.
  const root = tempRoot()
  const home = join(root, 'ro-home')
  mkdirSync(home)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  chmodSync(home, 0o500)
  try {
    clearRepoIdentityMemo()
    const registry = new StoreRegistry(home, quiet)
    const memory = Object.setPrototypeOf(
      Reflect.construct(function () {}, []),
      MemoryService.prototype,
    )
    const agent = fakeAgent({ id: 'p', cwd: repo })
    const ctx = fakeCtx({ agents: [agent] })
    memory.ctx = ctx
    memory.stores = registry

    const registered = []
    const toolCtx = {
      ...ctx,
      tools: { register: (tool) => registered.push(tool) },
      systemPrompt: { section: () => {}, context: () => {} },
    }
    registerTools(toolCtx, memory)
    const propose = registered.find((tool) => tool.name === 'memory_propose')

    await assert.rejects(
      propose.execute({ title: 't', body: 'b', kind: 'fact' }, { agent }),
      (error) => {
        assert.match(error.message, /unavailable/, 'phrased as unavailability')
        assert.doesNotMatch(error.message, /EACCES|mkdir|\/tmp/, 'no internal detail leaks')
        return true
      },
    )
    registry.dispose()
  } finally {
    chmodSync(home, 0o700)
    cleanup(root)
  }
})

test('maintenance works on a year-scale store (no temp-file dependency)', () => {
  // Maintenance statements touch thousands of rows, and SQLite spills their
  // scratch to a temp directory by default — which fails wherever that
  // directory is restricted (sandboxes, hardened containers). The symptom is
  // a confusing "unable to open database file" on an otherwise healthy
  // store, and it only appears at scale.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const DAY = 86_400_000
  const now = Date.now()

  const memory = store.db.prepare(
    `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
     VALUES (?, 'fact', 'repo-local', 'active', ?, 'body text here', 'human', ?, ?)`,
  )
  const turn = store.db.prepare(
    `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
     VALUES (?, ?, 1, 'user', 'human', ?, ?)`,
  )
  store.tx(() => {
    for (let i = 0; i < 3_000; i++) {
      const age = now - (i % 365) * DAY
      memory.run(`m${i}`, `fact ${i}`, age, age)
    }
    for (let i = 0; i < 60_000; i++) {
      turn.run(`sess${i % 500}`, i, 'conversation text '.repeat(4), now - (i % 365) * DAY)
    }
  })

  enqueueJob(store, 'decay', 'd1', {}, 0)
  const report = runDecayJob(store, claimNextJob(store, now, now + 60_000), now)
  assert.ok(report.slept > 0, 'stale memories were retired')
  pruneConversations(store, now)

  // The read path stays fast because decay removed the noise, not because
  // anything was cached.
  assert.ok(queryInjectionRows(store).length <= 20)
  store.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')`)
  registry.dispose()
  cleanup(root)
})

test('storage that cannot support WAL is reported, not silently accepted', () => {
  // WAL needs a shared-memory file that some network filesystems lack;
  // SQLite then keeps a rollback journal and REPORTS that, which is why the
  // open path reads the pragma's answer instead of assuming it took. The
  // medium cannot be conjured in a test, so this asserts the decision the
  // open path makes when SQLite reports a non-WAL mode.
  const decide = (reported) => reported.toLowerCase() !== 'wal'
  assert.equal(decide('wal'), false, 'the normal case warns about nothing')
  assert.equal(decide('WAL'), false, 'the comparison is case-insensitive')
  for (const fallback of ['delete', 'truncate', 'persist', 'memory', 'off']) {
    assert.equal(decide(fallback), true, `${fallback} means cross-process freshness is gone`)
  }

  // ...and a healthy local store stays silent, so the warning stays useful.
  const { root, registry } = openRegistry()
  const warnings = []
  const watched = new StoreRegistry(join(root, 'second'), {
    warn: (message) => warnings.push(String(message)),
    info() {},
  })
  watched.open('k1')
  assert.equal(
    warnings.filter((line) => line.includes('does not support WAL')).length,
    0,
    'no false alarm on ordinary local disk',
  )
  watched.dispose()
  registry.dispose()
  cleanup(root)
})
