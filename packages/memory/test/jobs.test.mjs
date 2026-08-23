/** §10 concurrency/crash domain: claims, leases, fencing-first, poison, cleanup. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueJob,
  claimNextJob,
  commitClaimedJob,
  failClaimedJob,
  cleanupJobs,
  isPoisoned,
  jobId,
  FencingError,
} from '../lib/pipeline/jobs.js'
import { MAX_CLAIMS } from '../lib/constants.js'
import { openRegistry, cleanup } from './helpers.mjs'

const setup = () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  return { root, registry, store }
}

test('idempotent enqueue: same key absorbed, different key inserted', () => {
  const { root, registry, store } = setup()
  const id = jobId('extract', 'k1', 's', 1)
  enqueueJob(store, 'extract', id, { a: 1 }, 0)
  enqueueJob(store, 'extract', id, { a: 2 }, 0) // absorbed — payload unchanged
  enqueueJob(store, 'extract', jobId('extract', 'k1', 's', 2), { a: 3 }, 0)
  const rows = store.db.prepare(`SELECT id, payload FROM jobs ORDER BY created_at`).all()
  assert.equal(rows.length, 2)
  assert.deepEqual(JSON.parse(rows[0].payload), { a: 1 })
  registry.dispose()
  cleanup(root)
})

test('two workers claim: exactly one wins; attempts increments on claim', () => {
  const { root, registry, store } = setup()
  enqueueJob(store, 'extract', 'j1', {}, 0)
  const now = Date.now()
  const a = claimNextJob(store, now, now + 1000)
  const b = claimNextJob(store, now, now + 1000)
  assert.ok(a)
  assert.equal(b, undefined)
  assert.equal(a.attempts, 1)
  registry.dispose()
  cleanup(root)
})

test('expired lease is reclaimable; late worker is fenced BEFORE business writes', () => {
  const { root, registry, store } = setup()
  enqueueJob(store, 'extract', 'j1', {}, 0)
  const t0 = Date.now()
  const stale = claimNextJob(store, t0, t0 + 10) // tiny lease
  const successor = claimNextJob(store, t0 + 20, t0 + 20_000) // reclaims after expiry
  assert.ok(successor)
  assert.equal(successor.attempts, 2)

  // The stale worker tries to commit with business writes — fencing throws
  // FIRST and the mutate closure must never run.
  let mutated = false
  assert.throws(
    () =>
      commitClaimedJob(store, 'j1', stale.leaseToken, () => {
        mutated = true
      }),
    FencingError,
  )
  assert.equal(mutated, false)
  // zero business writes AND job still owned by successor
  const row = store.db.prepare(`SELECT state, lease_token FROM jobs WHERE id = 'j1'`).get()
  assert.equal(row.state, 'running')
  assert.equal(row.lease_token, successor.leaseToken)

  // successor commits fine
  commitClaimedJob(store, 'j1', successor.leaseToken, () => {
    store.db.prepare(`INSERT INTO meta (k, v) VALUES ('done-by', 'successor')`).run()
  })
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get().state, 'done')
  assert.equal(store.db.prepare(`SELECT v FROM meta WHERE k = 'done-by'`).get().v, 'successor')
  registry.dispose()
  cleanup(root)
})

test('business failure rolls back the done state too (single transaction)', () => {
  const { root, registry, store } = setup()
  enqueueJob(store, 'extract', 'j1', {}, 0)
  const now = Date.now()
  const job = claimNextJob(store, now, now + 10_000)
  assert.throws(() =>
    commitClaimedJob(store, 'j1', job.leaseToken, () => {
      throw new Error('business exploded')
    }),
  )
  const row = store.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get()
  assert.equal(row.state, 'running') // not done — rolled back together
  registry.dispose()
  cleanup(root)
})

test('poison job: claim count crosses MAX_CLAIMS and dead-letters', () => {
  const { root, registry, store } = setup()
  enqueueJob(store, 'extract', 'j1', {}, 0)
  let job
  for (let i = 0; i <= MAX_CLAIMS; i++) {
    const now = Date.now()
    job = claimNextJob(store, now, now - 1) // lease already expired ⇒ reclaimable
    assert.ok(job, `claim ${i}`)
  }
  assert.ok(isPoisoned(job))
  failClaimedJob(store, 'j1', job.leaseToken, job.attempts, true)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get().state, 'failed')
  registry.dispose()
  cleanup(root)
})

test('retry exit reschedules with backoff under lease protection', () => {
  const { root, registry, store } = setup()
  enqueueJob(store, 'extract', 'j1', {}, 0)
  const now = Date.now()
  const job = claimNextJob(store, now, now + 10_000)
  failClaimedJob(store, 'j1', job.leaseToken, job.attempts, false)
  const row = store.db.prepare(`SELECT state, run_after FROM jobs WHERE id = 'j1'`).get()
  assert.equal(row.state, 'pending')
  assert.ok(row.run_after > now)
  // a worker with a stale token cannot flip it back
  failClaimedJob(store, 'j1', 'stale-token', 99, true)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get().state, 'pending')
  registry.dispose()
  cleanup(root)
})

test('cleanup deletes aged done/failed rows only', () => {
  const { root, registry, store } = setup()
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
         VALUES ('old-done', 'extract', '{}', 'done', 1, 0, 0, ?),
                ('old-failed', 'extract', '{}', 'failed', 1, 0, 0, ?),
                ('fresh-done', 'extract', '{}', 'done', 1, 0, 0, ?),
                ('pending', 'extract', '{}', 'pending', 0, 0, 0, NULL)`,
      )
      .run(now - 8 * 86_400_000, now - 31 * 86_400_000, now)
  })
  cleanupJobs(store, now)
  const left = store.db.prepare(`SELECT id FROM jobs ORDER BY id`).all().map((r) => r.id)
  assert.deepEqual(left, ['fresh-done', 'pending'])
  registry.dispose()
  cleanup(root)
})
