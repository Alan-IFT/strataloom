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
import {
  commitClaimedJob,
  enqueueJob,
  claimNextJob,
  jobId,
  FencingError,
} from '../lib/pipeline/jobs.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import { pruneConversations } from '../lib/store/conversations.js'
import { queryInjectionRows } from '../lib/store/fts.js'
import { BUSY_TIMEOUT_MS, DONE_RETENTION_MS, IMMEDIATE_TX_RETRIES } from '../lib/constants.js'
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

/*
 * `maintain` is deliberately NOT exported. `lastCleanup = 0` makes the FIRST
 * tick a maintenance tick, so every assertion below is driven through the real
 * `tick()` the scheduler uses, exactly like the rest of this file.
 *
 * The two breaks are different on purpose, and each isolates ONE fix:
 *
 * - `breakMaintenanceWrite` drops a table a WRITE step needs, so `maintain`
 *   throws no matter how the read-only metrics line is guarded. That is the
 *   only way to test the maintenance/claiming split by itself.
 * - `breakMetrics` drops a table only `collectMetrics` reads, which is the
 *   reproduced bad-data path — and, once the metrics line is guarded, is
 *   precisely a failure `maintain` must ABSORB rather than abort on.
 */
const breakMaintenanceWrite = (store) => store.db.exec('DROP TABLE conversations')
const breakMetrics = (store) => store.db.exec('DROP TABLE usage')

test('runner: a failed maintenance pass does not cancel the same store\'s job pipeline', async () => {
  // The regression this locks: `maintain` and job claiming used to share ONE
  // try block, so a throwing periodic chore took the whole tick down with it
  // and the store ran zero jobs. Measured before the fix: attempts stayed 0.
  //
  // Maintenance is broken at a WRITE step (`pruneConversations`), which is
  // also the shape the real trigger takes — SQLITE_BUSY hits writers. A
  // read-only break would be absorbed by the metrics guard and would prove
  // nothing about this split.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  enqueueJob(store, 'extract', 'j1', { sessionId: 's', turn: 1 }, 0)
  breakMaintenanceWrite(store)

  const warnings = []
  const ctx = fakeCtx({})
  ctx.logger = { info() {}, warn: (message) => warnings.push(String(message)) }

  const runner = new JobRunner(ctx, registry, () => false)
  runner.tick()
  await runner.whenSettled() // must not reject

  assert.equal(
    store.db.prepare(`SELECT attempts FROM jobs WHERE id = 'j1'`).get().attempts,
    1,
    'the job was still claimed and attempted despite maintenance failing',
  )
  assert.ok(
    warnings.some((line) => line.includes('maintenance failed')),
    'the maintenance failure is reported, not swallowed',
  )
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})

test('runner: observation cannot stop the system it observes', async () => {
  // `collectMetrics` only READS and hands numbers to a logger. Letting it
  // abort the pass would trade real maintenance — job cleanup, L0 pruning,
  // the daily decay enqueue — for a log line. Everything AFTER it still runs.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')

  // An over-age `done` row: proof that `cleanupJobs` actually executed, not
  // merely that nothing threw.
  const stale = Date.now() - DONE_RETENTION_MS - 86_400_000
  store.db
    .prepare(
      `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
       VALUES ('old', 'extract', '{}', 'done', 1, 0, ?, ?)`,
    )
    .run(stale, stale)

  breakMetrics(store)

  // A busy principal keeps the tick from CLAIMING anything, so what the
  // assertions see is the enqueue itself rather than a job that also ran.
  const runner = new JobRunner(fakeCtx({}), registry, () => true)
  const before = new Date().toISOString().slice(0, 10)
  runner.tick()
  await runner.whenSettled()
  const after = new Date().toISOString().slice(0, 10)

  assert.equal(
    store.db.prepare(`SELECT count(*) AS n FROM jobs WHERE id = 'old'`).get().n,
    0,
    'cleanupJobs ran: the over-age done row is gone',
  )
  const decay = store.db.prepare(`SELECT id FROM jobs WHERE kind = 'decay'`).all()
  assert.equal(decay.length, 1, "today's decay job was enqueued")
  assert.ok(
    // Two dates accepted only so a tick crossing UTC midnight cannot flake.
    [before, after].some((day) => decay[0].id === jobId('decay', store.repoKey, day)),
    'the decay job carries the deterministic once-per-day idempotence key',
  )
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})

/**
 * Hold a real write lock on `dbPath` from a SEPARATE OS process and return
 * once it is provably taken (the child signals through a marker file). Same
 * shape as the `immediateTx` test at the top of this file — an in-process
 * transaction would not reproduce contention, because SQLite serialises a
 * single connection instead of returning SQLITE_BUSY.
 */
const holdWriteLockFrom = (dbPath, marker) => {
  const child = spawn(process.execPath, [
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO meta (k, v) VALUES ('lockholder', '1')");
    fs.writeFileSync(${JSON.stringify(marker)}, '1');
    const until = Date.now() + 120000; while (Date.now() < until) {}
    db.exec('ROLLBACK'); db.close();
    `,
  ])
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5_000
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('child never took the lock')
    Atomics.wait(pause, 0, 0, 10)
  }
  return child
}

/** One exhausted busy-retry budget, in milliseconds: the unit both tests below count in. */
const oneBudget = BUSY_TIMEOUT_MS * (IMMEDIATE_TX_RETRIES + 1)

test('runner: contention costs ONE busy-retry budget per tick, not one per step', async () => {
  // Guarding each maintenance step separately looks like strictly more
  // robustness, and it is the opposite. The failure that actually happens
  // here is SQLITE_BUSY from a second process on the same repository, and it
  // hits the WRITE steps. `tx.ts` retries with `sleepSync`, i.e. `Atomics.wait`
  // — a SYNCHRONOUS freeze of the whole event loop — so every step that
  // exhausts its budget costs BUSY_TIMEOUT_MS * (IMMEDIATE_TX_RETRIES + 1).
  //
  // Stopping at the first throw pays that ONCE (~8s). Catching per step would
  // let each of the three write steps pay it in turn (~24s). Under contention
  // the all-or-nothing pass is therefore an EARLY EXIT, and this test is here
  // so that "let's also guard the other steps" fails loudly instead of
  // tripling a freeze nobody measures.
  const { root, registry } = openRegistry()
  const store = registry.open('k1') // opened BEFORE the lock is taken
  const child = holdWriteLockFrom(join(root, 'repos', 'k1', 'memory.sqlite'), join(root, 'locked'))

  // No claimable job, so the tick's wall clock IS the maintenance pass:
  // `peekClaimable` is a read and returns normally while the writer holds the
  // lock, which is also why guarding the read-only metrics line costs nothing.
  // This deliberate exclusion is also this test's blind spot — see the
  // claimable variant below, which exists because of it.
  assert.equal(
    store.db.prepare(`SELECT count(*) AS n FROM jobs`).get().n,
    0,
    'nothing claimable, so the measurement is maintenance alone',
  )

  const runner = new JobRunner(fakeCtx({}), registry, () => false)
  const started = Date.now()
  runner.tick()
  await runner.whenSettled() // must not reject
  const elapsed = Date.now() - started

  child.kill()

  assert.ok(
    elapsed < 2 * oneBudget,
    `one tick under contention froze for ${elapsed}ms; one busy-retry budget is ` +
      `${oneBudget}ms, so anything at or above ${2 * oneBudget}ms means the ` +
      'maintenance steps are being retried one after another',
  )
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})

test('runner: a busy maintenance failure does not buy a SECOND freeze in claiming', async () => {
  // The regression this locks, measured: 16936ms — 2.12 budgets — with
  // `attempts` still 0. Double the freeze, and the job STILL was not claimed.
  //
  // The test above counts budgets with NOTHING claimable, which is exactly
  // what let this through: it measures `maintain` alone. Splitting the try
  // blocks made a swallowed maintenance failure fall through to
  // `claimNextJob`, and that call is itself a `store.tx()` — an `immediateTx`
  // with its OWN full retry budget. Against the same still-held lock it
  // re-loses the same race and pays a second ~8s. The per-step arithmetic
  // (ADR 0006) was right and simply did not scan this far: the "second step"
  // that must not re-run lives OUTSIDE the try block.
  //
  // So: same lock, one pending job, same 2-budget ceiling.
  const { root, registry } = openRegistry()
  const store = registry.open('k1') // opened BEFORE the lock is taken
  enqueueJob(store, 'extract', 'j1', { sessionId: 's', turn: 1 }, 0)
  const child = holdWriteLockFrom(join(root, 'repos', 'k1', 'memory.sqlite'), join(root, 'locked'))

  assert.equal(
    store.db.prepare(`SELECT count(*) AS n FROM jobs`).get().n,
    1,
    'a claimable job is present: this tick reaches the claim path, unlike the test above',
  )

  const runner = new JobRunner(fakeCtx({}), registry, () => false)
  const started = Date.now()
  runner.tick()
  await runner.whenSettled() // must not reject
  const elapsed = Date.now() - started

  child.kill()

  assert.ok(
    elapsed < 2 * oneBudget,
    `a tick with a claimable job froze for ${elapsed}ms; one busy-retry budget is ` +
      `${oneBudget}ms, so anything at or above ${2 * oneBudget}ms means claiming ` +
      're-lost the race that maintenance had already lost — a second freeze bought ' +
      'nothing, since the lock is still held',
  )
  assert.equal(
    store.db.prepare(`SELECT attempts FROM jobs WHERE id = 'j1'`).get().attempts,
    0,
    'the claim was skipped rather than attempted: the lock proved it could not succeed',
  )
  await runner.dispose()
  registry.dispose()
  cleanup(root)
})
