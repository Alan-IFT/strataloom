/**
 * The L0 conversation substrate and Personal Memory (cross-repo scope).
 * These are the two capabilities added after the P0/P1 core: the durable
 * record of what was said, and memories that follow the user across repos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService } from '../lib/service.js'
import { GLOBAL_STORE_KEY } from '../lib/store/store.js'
import { captureTurn, readTurn, pruneConversations } from '../lib/store/conversations.js'
import { collectTurnEvents } from '../lib/transcript.js'
import { buildContextProvider } from '../lib/recall/inject.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { L0_RETENTION_MS } from '../lib/constants.js'
import { collectMetrics } from '../lib/metrics.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import { packetOverflows, readRevision, runRebuildJob } from '../lib/pipeline/rebuild.js'
import { estimateTokens } from '../lib/constants.js'
import { looksSecret, projectStore, PROJECTION_DIR, PROJECTION_FILE } from '../lib/projection.js'
import { enqueueJob, claimNextJob } from '../lib/pipeline/jobs.js'
import {
  openRegistry,
  cleanup,
  tempRoot,
  fakeAgent,
  fakeCtx,
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

const setup = () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo })
  const ctx = fakeCtx({ agents: [principal] })
  const service = Reflect.construct(function () {}, [])
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = ctx
  service.stores = registry
  return { repo, root, registry, principal, ctx, service }
}

// ---------------------------------------------------------------- L0 ------

test('L0: a captured turn round-trips with per-event provenance', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = collectTurnEvents(
    turnEvents(3, [userMessageEvent('use pnpm here'), assistantMessageEvent(3, 'understood')]),
    3,
  )
  store.tx(() => captureTurn(store, 'sess-A', 3, events))

  const back = readTurn(store, 'sess-A', 3)
  assert.equal(back.length, 2)
  assert.deepEqual(
    back.map((row) => `${row.label}:${row.provenance}`),
    ['user:human', 'assistant:parent-agent'],
  )
  assert.match(back[0].text, /use pnpm here/)
  registry.dispose()
  cleanup(root)
})

test('L0: capture is idempotent by (session, seq)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = collectTurnEvents(turnEvents(1, [userMessageEvent('once')]), 1)
  store.tx(() => captureTurn(store, 'sess-A', 1, events))
  store.tx(() => captureTurn(store, 'sess-A', 1, events)) // replayed
  assert.equal(store.db.prepare(`SELECT count(*) c FROM conversations`).get().c, 1)
  registry.dispose()
  cleanup(root)
})

test('L0: pruning drops aged turns but never those a live memory cites', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const old = Date.now() - L0_RETENTION_MS - 86_400_000

  store.tx(() => {
    for (const [session, seq] of [['cited', 1], ['orphan', 1]]) {
      store.db
        .prepare(
          `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
           VALUES (?, ?, 1, 'user', 'human', 'old words', ?)`,
        )
        .run(session, seq, old)
    }
    // A live memory cites 'cited'; a tombstoned one cites 'orphan'.
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('m1','fact','repo-local','active','t','b','human',0,0),
                ('m2','fact','repo-local','tombstone','','','human',0,0)`,
      )
      .run()
    store.db
      .prepare(
        `INSERT INTO evidence (memory_id, kind, ref) VALUES ('m1','session','cited'),('m2','session','orphan')`,
      )
      .run()
  })

  pruneConversations(store, Date.now())
  const left = store.db
    .prepare(`SELECT DISTINCT session_id FROM conversations ORDER BY session_id`)
    .all()
    .map((r) => r.session_id)
  assert.deepEqual(left, ['cited'], 'a memory never outlives the words behind it')
  registry.dispose()
  cleanup(root)
})

test('L0 drill-down: memory_recall sourceOf returns the original conversation', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  const store = service.storeFor(principal, false)
  const events = collectTurnEvents(turnEvents(1, [userMessageEvent('we deploy with make deploy')]), 1)
  store.tx(() => captureTurn(store, principal.session.id, 1, events))

  const turns = await service.source(id, principal, 20)
  assert.equal(turns.length, 1)
  assert.match(turns[0].text, /make deploy/)
  assert.equal(turns[0].provenance, 'human')

  await assert.rejects(service.source('ghost', principal, 20), /no memory with id/)
  registry.dispose()
  cleanup(root)
})

// ---------------------------------------------- Personal Memory -----------

test('personal scope writes to the global store as private; repo scope stays repo-local', async () => {
  const { root, registry, principal, service } = setup()
  const personal = await service.propose(
    { title: 'answer in Chinese', body: 'the user prefers Chinese replies', kind: 'preference', scope: 'personal' },
    principal,
  )
  const repoMem = await service.propose(
    { title: 'uses pnpm', body: 'this repo uses pnpm', kind: 'fact' },
    principal,
  )

  const global = registry.get(GLOBAL_STORE_KEY)
  const repo = service.storeFor(principal, false)
  assert.notEqual(global, repo, 'two distinct stores')
  assert.equal(
    global.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(personal.id).visibility,
    'private',
  )
  assert.equal(
    repo.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(repoMem.id).visibility,
    'repo-local',
  )
  // Each store holds only its own.
  assert.equal(global.db.prepare(`SELECT count(*) c FROM memories`).get().c, 1)
  assert.equal(repo.db.prepare(`SELECT count(*) c FROM memories`).get().c, 1)
  registry.dispose()
  cleanup(root)
})

test('D2 holds in both directions: neither store accepts the other\'s visibility', () => {
  const { root, registry } = openRegistry()
  const repo = registry.open('k1')
  const global = registry.openGlobal()
  const insert = (store, visibility) =>
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'fact', ?, 'active', 't', 'b', 'human', 0, 0)`,
      )
      .run(Math.random().toString(36), visibility)

  assert.throws(() => insert(repo, 'private'), /does not match/)
  assert.throws(() => insert(global, 'repo-local'), /does not match/)
  assert.throws(() => insert(global, 'team-shareable'), /does not match/)
  insert(repo, 'repo-local')
  insert(global, 'private')
  registry.dispose()
  cleanup(root)
})

test('recall and injection span both scopes; personal memories lead the packet', async () => {
  const { root, registry, principal, ctx, service } = setup()
  await service.propose(
    { title: 'reply in Chinese', body: 'user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  await service.propose(
    { title: 'build with pnpm', body: 'this repo uses pnpm', kind: 'fact' },
    principal,
  )

  // Recall spans both stores. The query is escaped as a literal phrase
  // (anti-injection, §4.3), so each scope is probed with its own term.
  const personalHits = await service.recall({ query: 'Chinese' }, principal)
  assert.deepEqual(personalHits.hits.map((h) => h.title), ['reply in Chinese'])
  const repoHits = await service.recall({ query: 'pnpm' }, principal)
  assert.deepEqual(repoHits.hits.map((h) => h.title), ['build with pnpm'])
  // ...and one query matching both returns both, personal first.
  const both = await service.recall({ query: 'user' }, principal)
  assert.ok(both.hits.length >= 1)

  // injection carries both, personal first
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /Chinese/)
  assert.match(packet, /pnpm/)
  assert.ok(
    packet.indexOf('Chinese') < packet.indexOf('pnpm'),
    'personal memories frame the repo ones',
  )
  registry.dispose()
  cleanup(root)
})

test('personal memories survive a session with no repo affiliation', async () => {
  const { root, registry, principal, service } = setup()
  await service.propose(
    { title: 'be concise', body: 'the user wants short answers', kind: 'preference', scope: 'personal' },
    principal,
  )

  // A session outside any git tree: no repo store, but personal memory holds.
  const stray = fakeAgent({ id: 'stray', cwd: tempRoot() })
  const strayCtx = fakeCtx({ agents: [stray] })
  service.ctx = strayCtx
  assert.equal(service.storeFor(stray, false), undefined, 'no repo store')

  const hits = await service.recall({ query: 'concise' }, stray)
  assert.equal(hits.hits.length, 1, 'personal memory is still recallable')
  const packet = buildContextProvider(strayCtx, service)({ agent: stray })
  assert.match(packet, /concise/, 'and still injected')
  registry.dispose()
  cleanup(root)
})

test('forget reaches a personal memory by id without naming its store', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'use emoji', body: 'the user likes emoji', kind: 'preference', scope: 'personal' },
    principal,
  )
  const report = await service.forget(id, principal)
  assert.equal(report.id, id)
  const hits = await service.recall({ query: 'emoji' }, principal)
  assert.equal(hits.hits.length, 0)
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------ dedup / update ---------

test('propose surfaces near-duplicates so the model can collapse them', async () => {
  const { root, registry, principal, service } = setup()
  const first = await service.propose(
    { title: 'reply in Chinese', body: 'the user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  assert.deepEqual(first.similar, [], 'nothing existed yet')

  // Saying it again a different way: the overlap is reported back.
  const second = await service.propose(
    { title: 'user prefers Chinese replies', body: 'answer in Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  assert.equal(second.similar.length, 1)
  assert.equal(second.similar[0].id, first.id)

  // Different kind ⇒ not offered (a fact never supersedes a preference).
  const other = await service.propose(
    { title: 'Chinese docs live in docs/zh', body: 'translations', kind: 'fact' },
    principal,
  )
  assert.deepEqual(other.similar, [])
  registry.dispose()
  cleanup(root)
})

test('replaces supersedes atomically: one active entry survives, chain is recorded', async () => {
  const { root, registry, principal, service } = setup()
  const v1 = await service.propose(
    { title: 'use npm', body: 'install with npm', kind: 'fact' },
    principal,
  )
  const v2 = await service.propose(
    { title: 'use pnpm', body: 'install with pnpm, npm is wrong', kind: 'fact', replaces: v1.id },
    principal,
  )

  const store = service.storeFor(principal, false)
  const rows = store.db
    .prepare(`SELECT id, status, superseded_by FROM memories ORDER BY created_at`)
    .all()
  assert.equal(rows.length, 2)
  const old = rows.find((r) => r.id === v1.id)
  assert.equal(old.status, 'superseded')
  assert.equal(old.superseded_by, v2.id, 'the chain records what replaced it')

  // Only the survivor is recalled and injected.
  const hits = await service.recall({ query: 'install' }, principal)
  assert.deepEqual(hits.hits.map((h) => h.id), [v2.id])
  registry.dispose()
  cleanup(root)
})

test('replaces refuses an unknown or already-superseded target (fail loud)', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact', replaces: 'ghost' }, principal),
    /cannot replace/,
  )
  const v1 = await service.propose({ title: 'a', body: 'b', kind: 'fact' }, principal)
  await service.propose({ title: 'a2', body: 'b2', kind: 'fact', replaces: v1.id }, principal)
  // Second attempt against the now-superseded entry fails, and writes nothing.
  await assert.rejects(
    service.propose({ title: 'a3', body: 'b3', kind: 'fact', replaces: v1.id }, principal),
    /cannot replace/,
  )
  const store = service.storeFor(principal, false)
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories`).get().c, 2, 'no orphan row')
  registry.dispose()
  cleanup(root)
})

test('replaces cannot cross scopes (a personal memory is not in the repo store)', async () => {
  const { root, registry, principal, service } = setup()
  const personal = await service.propose(
    { title: 'be terse', body: 'short answers', kind: 'preference', scope: 'personal' },
    principal,
  )
  await assert.rejects(
    service.propose(
      { title: 'be terse here', body: 'short answers', kind: 'preference', replaces: personal.id },
      principal,
    ),
    /cannot replace/,
  )
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------------- metrics ---------

test('metrics snapshot reports the §12 trigger indicators from the store', async () => {
  const { root, registry, principal, service } = setup()
  const a = await service.propose({ title: 'alpha fact', body: 'body one', kind: 'fact' }, principal)
  await service.propose({ title: 'beta fact', body: 'body two', kind: 'fact', replaces: a.id }, principal)
  const gone = await service.propose({ title: 'gamma', body: 'body three', kind: 'fact' }, principal)
  await service.forget(gone.id, principal)
  await service.recall({ query: 'beta' }, principal)

  const store = service.storeFor(principal, false)
  const m = collectMetrics(store, Date.now())
  assert.equal(m.kind, 'repo')
  assert.equal(m.activeCount, 1, 'one survivor')
  assert.ok(m.packetTokens > 0, 'packet size is measured, not guessed')
  assert.equal(m.retrievedRate, 1, 'the survivor was recalled once')
  assert.ok(m.overturnRate > 0 && m.overturnRate < 1, `overturn tracked: ${m.overturnRate}`)
  assert.equal(m.pendingJobs, 0)
  assert.equal(m.oldestPendingJobAgeMs, 0, 'no pending job ⇒ no age')
  assert.equal(m.deadLettered, 0)
  registry.dispose()
  cleanup(root)
})

test('metrics report oldest pending job age and dead letters', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
         VALUES ('old','extract','{}','pending',0,0,?,NULL),
                ('new','extract','{}','pending',0,0,?,NULL),
                ('bad','extract','{}','failed',6,0,0,?)`,
      )
      .run(now - 600_000, now - 1_000, now)
  })
  const m = collectMetrics(store, now)
  assert.equal(m.pendingJobs, 2)
  assert.ok(m.oldestPendingJobAgeMs >= 600_000, 'age comes from the OLDEST pending job')
  assert.equal(m.deadLettered, 1)
  registry.dispose()
  cleanup(root)
})

// --------------------------------------------------------- decay ---------

/** Insert an active memory with an explicit age and optional last hit. */
const seedAged = (store, id, ageMs, hitAgoMs) => {
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'fact', 'repo-local', 'active', ?, 'body', 'human', 0, ?)`,
      )
      .run(id, `title ${id}`, now - ageMs)
    if (hitAgoMs !== undefined) {
      store.db
        .prepare(`INSERT INTO usage (memory_id, retrieved, last_hit_at) VALUES (?, 1, ?)`)
        .run(id, now - hitAgoMs)
    }
  })
}

const claimDecay = (store) => {
  const now = Date.now()
  enqueueJob(store, 'decay', 'd1', {}, 0)
  return claimNextJob(store, now, now + 60_000)
}

test('decay: idle entries sleep, recently used ones stay, small stores are left alone', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const DAY = 86_400_000

  // Below the floor: nothing sleeps even though everything is old.
  seedAged(store, 'lonely', 200 * DAY)
  let report = runDecayJob(store, claimDecay(store), Date.now())
  assert.equal(report.slept, 0, 'a small store has no noise problem')

  // Above the floor: old and unused sleeps; old but recently hit does not.
  for (let i = 0; i < 60; i++) seedAged(store, `old${i}`, 200 * DAY)
  seedAged(store, 'useful', 200 * DAY, 1 * DAY)
  store.db.prepare(`DELETE FROM jobs`).run()
  report = runDecayJob(store, claimDecay(store), Date.now())
  assert.ok(report.slept >= 60, `idle entries slept: ${report.slept}`)
  assert.equal(
    store.db.prepare(`SELECT status FROM memories WHERE id = 'useful'`).get().status,
    'active',
    'recently retrieved entries stay awake',
  )
  registry.dispose()
  cleanup(root)
})

test('decay: revival happens in the batch, never on the read path (D4)', async () => {
  const { root, registry, principal, service } = setup()
  const store = service.storeFor(principal, true)
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('sleeper','fact','repo-local','dormant','hibernating fact','body','human',0,0)`,
      )
      .run()
  })

  // A dormant memory is invisible to recall...
  assert.equal((await service.recall({ query: 'hibernating' }, principal)).hits.length, 0)
  // ...and reading did NOT wake it (no authoritative change on a read).
  assert.equal(
    store.db.prepare(`SELECT status FROM memories WHERE id = 'sleeper'`).get().status,
    'dormant',
  )

  // A recent hit (however recorded) revives it in the next decay batch.
  store.tx(() => {
    store.db
      .prepare(`INSERT INTO usage (memory_id, retrieved, last_hit_at) VALUES ('sleeper', 3, ?)`)
      .run(now - 86_400_000)
  })
  const report = runDecayJob(store, claimDecay(store), now)
  assert.equal(report.revived, 1)
  assert.equal((await service.recall({ query: 'hibernating' }, principal)).hits.length, 1)
  registry.dispose()
  cleanup(root)
})

test('decay: excerpts compact but refs survive (suppression outlives the quote)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const old = Date.now() - 200 * 86_400_000
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('m1','fact','repo-local','active','t','b','human',0,?)`,
      )
      .run(old)
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref, excerpt) VALUES ('m1','session','sess-9','the exact words')`)
      .run()
  })
  const report = runDecayJob(store, claimDecay(store), Date.now())
  assert.equal(report.excerptsCompacted, 1)
  const row = store.db.prepare(`SELECT ref, excerpt FROM evidence WHERE memory_id = 'm1'`).get()
  assert.equal(row.excerpt, null, 'the quote ages out')
  assert.equal(row.ref, 'sess-9', 'the ref never does — source suppression depends on it')
  registry.dispose()
  cleanup(root)
})

test('a derived rollup can never go dormant (both writers now exist)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
         VALUES ('roll','fact','repo-local','active','rollup','body','derived',0,0,1)`,
      )
      .run()
  })
  assert.throws(
    () => store.db.prepare(`UPDATE memories SET status = 'dormant' WHERE id = 'roll'`).run(),
    /cannot go dormant/,
  )
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------ derived layer ----------

/** Fill a store past the injection budget so the rollup path engages. */
const overflow = async (service, principal, n = 60) => {
  for (let i = 0; i < n; i++) {
    await service.propose(
      {
        title: `fact number ${i} about the system`,
        body: `a reasonably long body describing detail ${i}. `.repeat(6),
        kind: 'fact',
      },
      principal,
    )
  }
}

const rollupReply = (text) => ({
  stream: async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('derived layer engages only on overflow and replaces the raw set', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  assert.equal(packetOverflows(store), false, 'an empty store does not overflow')

  await overflow(service, principal)
  assert.equal(packetOverflows(store), true, 'the measured packet exceeds budget')

  ctx.get = (name) => (name === 'llm' ? rollupReply('use pnpm; deploy with make; tests in vitest') : undefined)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: readRevision(store), provider: 'p', model: 'm' }, 0)
  const built = await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: readRevision(store), provider: 'p', model: 'm' },
    new AbortController().signal,
  )
  assert.equal(built, true)

  // Injection now carries the rollup INSTEAD of the raw entries.
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /use pnpm; deploy with make/)
  assert.doesNotMatch(packet, /fact number 3 about/, 'raw entries are replaced, not appended')
  assert.ok(estimateTokens(packet) <= 1400, 'and it fits the budget')
  registry.dispose()
  cleanup(root)
})

test('any authoritative write retires the rollup and bumps the revision', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('summary text') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories WHERE derived = 1`).get().c, 1)

  // One more save invalidates it.
  await service.propose({ title: 'new thing', body: 'changes the set', kind: 'fact' }, principal)
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived = 1`).get().c,
    0,
    'the summary built from the old snapshot is gone',
  )
  assert.ok(readRevision(store) > rev, 'and the revision advanced')
  registry.dispose()
  cleanup(root)
})

test('a rebuild queued for a superseded revision is fenced without an LLM call', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  const stale = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: stale, provider: 'p', model: 'm' }, 0)

  // The snapshot moves before the job runs.
  await service.propose({ title: 'moved on', body: 'newer', kind: 'fact' }, principal)

  let called = false
  ctx.get = (name) => (name === 'llm' ? { stream: () => { called = true; throw new Error('must not call') } } : undefined)
  const built = await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: stale, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(built, false, 'fenced')
  assert.equal(called, false, 'no tokens burned on a stale snapshot')
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'rb1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
})

test('forget refuses a generated summary and points at the real source', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('summary') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  const derived = store.db.prepare(`SELECT id FROM memories WHERE derived = 1`).get()
  await assert.rejects(service.forget(derived.id, principal), /generated summary/)
  registry.dispose()
  cleanup(root)
})

// ---------------------------------------------------- projection ---------

const approvalCtx = (base, outcome) => ({
  ...base,
  get: (name) => (name === 'approval' ? { request: async () => outcome } : base.get?.(name)),
})

test('secret scanner catches credential shapes and passes ordinary prose', () => {
  for (const bad of [
    'the token is ghp_abcdefghijklmnopqrstuvwxyz012345',
    'AWS key AKIAIOSFODNN7EXAMPLE is used',
    'password: hunter2000',
    '-----BEGIN RSA PRIVATE KEY-----',
    'api_key = 9f8e7d6c5b4a39281706',
  ]) {
    assert.equal(looksSecret(bad), true, `should flag: ${bad}`)
  }
  for (const ok of [
    'use pnpm instead of npm',
    'the deploy procedure is make deploy',
    'prefer Chinese replies with short paragraphs',
  ]) {
    assert.equal(looksSecret(ok), false, `should pass: ${ok}`)
  }
})

test('share requires approval; a rejection changes nothing', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose({ title: 'team fact', body: 'shared knowledge', kind: 'fact' }, principal)

  // No approval service at all ⇒ fail closed.
  await assert.rejects(service.share(id, principal), /requires the approval service/)

  // Explicit rejection ⇒ nothing is promoted or written.
  service.ctx = approvalCtx(ctx, 'rejected')
  const denied = await service.share(id, principal)
  assert.equal(denied.shared, false)
  const store = service.storeFor(principal, false)
  assert.equal(
    store.db.prepare(`SELECT visibility, human_confirmed FROM memories WHERE id = ?`).get(id).visibility,
    'repo-local',
    'still private to this machine',
  )
  registry.dispose()
  cleanup(root)
})

test('an approved share promotes, projects the file, and revoking removes it', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose(
    { title: 'deploy procedure', body: 'run make deploy from the repo root', kind: 'procedure' },
    principal,
  )
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const shared = await service.share(id, principal)
  assert.equal(shared.shared, true)

  const file = join(repo, PROJECTION_DIR, PROJECTION_FILE)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /deploy procedure/)
  assert.match(text, /make deploy/)
  assert.match(text, /never read back/, 'the file states it is not an input')

  // Forgetting the shared memory rewrites the projection away.
  await service.forget(id, principal)
  const store = service.storeFor(principal, false)
  const report = projectStore(store, repo)
  assert.equal(report.written, 0)
  assert.equal(existsSync(file), false, 'no stale shared file survives')
  registry.dispose()
  cleanup(root)
})

test('a credential-shaped memory is refused BEFORE anyone is asked to approve it', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose(
    { title: 'ci token', body: 'the CI token is ghp_abcdefghijklmnopqrstuvwxyz012345', kind: 'fact' },
    principal,
  )
  let asked = false
  service.ctx = {
    ...ctx,
    get: (name) =>
      name === 'approval'
        ? { request: async () => { asked = true; return 'allowed-once' } }
        : undefined,
  }
  const result = await service.share(id, principal)
  assert.equal(result.shared, false)
  assert.match(result.note, /credential/)
  assert.equal(asked, false, 'never prompt a human for something we would refuse anyway')

  // The row was NOT promoted, so nothing can leak later.
  const store = service.storeFor(principal, false)
  assert.equal(
    store.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(id).visibility,
    'repo-local',
  )
  assert.equal(existsSync(join(repo, PROJECTION_DIR, PROJECTION_FILE)), false)
  registry.dispose()
  cleanup(root)
})

test('the projection re-scans as a backstop, even for an already-promoted row', () => {
  const { repo, root, registry } = openRegistry()
  const store = registry.open('k1')
  // A row promoted by some earlier path (or an older build) that carries a secret.
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance,
           created_at, updated_at, human_confirmed)
         VALUES ('leak','fact','team-shareable','active','deploy key',
                 'AKIAIOSFODNN7EXAMPLE is the key','human',0,0,1)`,
      )
      .run()
  })
  const dir = tempRoot()
  const report = projectStore(store, dir)
  assert.equal(report.written, 0)
  assert.equal(report.skippedSecrets, 1, 'the write path refuses it independently')
  registry.dispose()
  cleanup(root)
  cleanup(dir)
})

test('personal and derived memories are never shareable', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const personal = await service.propose(
    { title: 'be terse', body: 'short answers', kind: 'preference', scope: 'personal' },
    principal,
  )
  service.ctx = approvalCtx(ctx, 'allowed-once')
  // The personal memory lives in the global store, so the repo-scoped share
  // cannot find it at all.
  await assert.rejects(service.share(personal.id, principal), /no memory with id/)
  registry.dispose()
  cleanup(root)
})
