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

test('a dead-lettered job is revived by the next trigger; pending/done still absorb', () => {
  // Regression for a live failure: the global store's L3 portrait job
  // dead-lettered at revision 3 and stayed unbuilt while five later
  // maintenance passes re-enqueued the same deterministic id into a
  // `DO NOTHING`. Dead-letter must end an attempt, not the work itself.
  const { root, registry, store } = setup()
  const id = jobId('rebuild', 'k1', 3)
  const payload = { expectedRevision: 3, provider: 'p', model: 'm' }
  enqueueJob(store, 'rebuild', id, payload, 0)

  let job
  for (let i = 0; i <= MAX_CLAIMS; i++) {
    const now = Date.now()
    job = claimNextJob(store, now, now - 1) // expired lease ⇒ reclaimable
  }
  failClaimedJob(store, id, job.leaseToken, job.attempts, true)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(id).state, 'failed')

  // The next maintenance pass re-triggers the SAME id (unchanged snapshot).
  const runAfter = Date.now() + 5_000
  enqueueJob(store, 'rebuild', id, payload, runAfter)
  const revived = store.db
    .prepare(`SELECT state, attempts, run_after, completed_at, lease_token FROM jobs WHERE id = ?`)
    .get(id)
  assert.equal(revived.state, 'pending', 'a dead letter is not a permanent veto')
  assert.equal(revived.attempts, 0, 'the retry budget is restored')
  assert.equal(revived.run_after, runAfter)
  assert.equal(revived.completed_at, null)
  assert.equal(revived.lease_token, null)
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM jobs WHERE id = ?`).get(id).c,
    1,
    'reviving must not duplicate the work',
  )

  // A job already scheduled absorbs the retrigger exactly as before.
  enqueueJob(store, 'rebuild', id, { expectedRevision: 99 }, 0)
  assert.deepEqual(
    JSON.parse(store.db.prepare(`SELECT payload FROM jobs WHERE id = ?`).get(id).payload),
    payload,
    'a pending job is not rewritten by a repeat trigger',
  )

  // And a finished snapshot is still not redone.
  const now = Date.now() + 10_000
  const claimed = claimNextJob(store, now, now + 10_000)
  commitClaimedJob(store, id, claimed.leaseToken, () => {})
  enqueueJob(store, 'rebuild', id, payload, 0)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(id).state, 'done')
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

test('a failing job records its cause; the dead-letter pass keeps the real one', () => {
  // Why a job is stuck must outlive the log line that said so — the L3
  // portrait dead letter had no recoverable cause days later.
  const { root, registry, store } = setup()
  enqueueJob(store, 'rebuild', 'j1', {}, 0)
  const now = Date.now()
  const first = claimNextJob(store, now, now + 10_000)
  failClaimedJob(store, 'j1', first.leaseToken, first.attempts, false, new TypeError('bad reply'))
  assert.equal(
    store.db.prepare(`SELECT last_error FROM jobs WHERE id='j1'`).get().last_error,
    'TypeError: bad reply',
  )

  // The dead-letter pass never ran the handler, so it has no diagnosis and
  // must not erase the one that explains the failure.
  const last = claimNextJob(store, Date.now() + 200_000, Date.now() + 210_000)
  failClaimedJob(store, 'j1', last.leaseToken, last.attempts, true)
  const dead = store.db.prepare(`SELECT state, last_error FROM jobs WHERE id='j1'`).get()
  assert.equal(dead.state, 'failed')
  assert.equal(dead.last_error, 'TypeError: bad reply', 'the cause survives dead-lettering')

  // A revived job starts clean rather than carrying a stale explanation.
  enqueueJob(store, 'rebuild', 'j1', {}, 0)
  assert.equal(store.db.prepare(`SELECT last_error FROM jobs WHERE id='j1'`).get().last_error, null)
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

/** Put the store at a known snapshot so the reachability predicate has one. */
const setRevision = (store, revision) => {
  store.db
    .prepare(`INSERT INTO meta (k, v) VALUES ('store_revision', ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(String(revision))
}

const insertFailed = (store, id, kind, payload, completedAt) => {
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
         VALUES (?, ?, ?, 'failed', 6, 0, 0, ?)`,
      )
      .run(id, kind, JSON.stringify(payload), completedAt)
  })
}

const idsIn = (store) =>
  store.db.prepare(`SELECT id FROM jobs ORDER BY id`).all().map((r) => r.id)

test('cleanup drops an unreachable rebuild regardless of age, and keeps a reachable one', () => {
  // The row's id is derived from the revision it was queued for, so a store at
  // a later revision can never compute that id again — it is garbage the moment
  // the snapshot moves, not 30 days later. The reachable twin must survive:
  // the next trigger revives it (see the dead-letter revival test above).
  const { root, registry, store } = setup()
  const now = Date.now()
  setRevision(store, 11)
  insertFailed(store, 'stale-rebuild', 'rebuild', { expectedRevision: 3 }, now)
  insertFailed(store, 'live-rebuild', 'rebuild', { expectedRevision: 11 }, now)

  cleanupJobs(store, now)
  assert.deepEqual(
    idsIn(store),
    ['live-rebuild'],
    'age plays no part: the superseded snapshot alone decides',
  )
  registry.dispose()
  cleanup(root)
})

test('a fresh extract dead letter survives the rebuild sweep, then ages out normally', () => {
  // extract/reconcile/decay payloads carry no expectedRevision, so the SQL sees
  // NULL there. With `!=` the comparison would be NULL — falsy — and the row
  // would be spared by accident rather than by rule; `IS NOT` makes the kind
  // filter the thing that spares it. This dead letter is the ONLY record that
  // one turn's distillation was abandoned for good (its id is fixed to that
  // turn, which never comes back), so it must keep the full retention window.
  const { root, registry, store } = setup()
  const now = Date.now()
  setRevision(store, 11)
  insertFailed(store, 'fresh-extract', 'extract', { sessionId: 's', turn: 9 }, now)
  insertFailed(store, 'fresh-reconcile', 'reconcile', { sessionId: 's', turn: 9 }, now)

  cleanupJobs(store, now)
  assert.deepEqual(idsIn(store), ['fresh-extract', 'fresh-reconcile'])

  // The age path is untouched: past 30 days the same rows go.
  cleanupJobs(store, now + 31 * 86_400_000)
  assert.deepEqual(idsIn(store), [])
  registry.dispose()
  cleanup(root)
})

test('a rebuild with no expectedRevision is unreachable too, not spared by a NULL', () => {
  // This is the case that pins `IS NOT` over `!=`, and it is NOT the extract
  // case: the kind filter already spares extract, so flipping the operator
  // leaves every other test green. Here `json_extract` yields NULL, and
  // `NULL != 11` is NULL — WHERE reads that as false and keeps the row forever.
  // A rebuild that cannot name its snapshot can never be matched to one, so the
  // honest reading is "does not match", exactly as runRebuildJob's fence treats
  // a revision that fails to compare equal.
  const { root, registry, store } = setup()
  const now = Date.now()
  setRevision(store, 11)
  insertFailed(store, 'rebuild-no-revision', 'rebuild', {}, now)

  cleanupJobs(store, now)
  assert.deepEqual(idsIn(store), [], 'a NULL revision must not read as "still current"')
  registry.dispose()
  cleanup(root)
})

test('deleting an unreachable rebuild leaves revival intact for the current snapshot', () => {
  // Cleanup must not be a veto in disguise. Asserting pending/attempts=0 on the
  // post-delete row alone proves nothing — a row that was NEVER deleted and got
  // revived in place satisfies the same three assertions. So compare the two
  // paths directly: the INSERT taken after a delete, and the UPDATE revival
  // taken when the row survives, must land on the SAME state. That equality is
  // what "cleanup did not change the outcome" actually means.
  const { root, registry, store } = setup()
  const now = Date.now()
  const id = jobId('rebuild', 'k1', 11)
  const live = { expectedRevision: 11, provider: 'p', model: 'm' }
  const observe = () =>
    store.db
      .prepare(
        `SELECT kind, payload, state, attempts, run_after, completed_at,
                lease_token, lease_until, last_error FROM jobs WHERE id = ?`,
      )
      .get(id)

  // Path A: the stale row is swept, so the trigger takes the INSERT branch.
  setRevision(store, 11)
  insertFailed(store, id, 'rebuild', { expectedRevision: 3 }, now)
  cleanupJobs(store, now)
  assert.deepEqual(idsIn(store), [], 'the superseded row is gone')
  enqueueJob(store, 'rebuild', id, live, 4242)
  const afterInsert = observe()

  // Path B: the same id is dead-lettered while still reachable, so cleanup
  // spares it and the very same trigger takes the ON CONFLICT revival branch.
  store.tx(() => store.db.prepare(`DELETE FROM jobs`).run())
  insertFailed(store, id, 'rebuild', live, now)
  store.db
    .prepare(`UPDATE jobs SET last_error = 'TypeError: bad reply' WHERE id = ?`)
    .run(id)
  cleanupJobs(store, now)
  assert.deepEqual(idsIn(store), [id], 'a reachable dead letter is not swept')
  enqueueJob(store, 'rebuild', id, live, 4242)
  const afterRevival = observe()

  assert.deepEqual(
    afterInsert,
    afterRevival,
    'revival and re-insert are the same job in the same state — cleanup is not a veto',
  )
  assert.equal(afterInsert.state, 'pending')
  assert.equal(afterInsert.attempts, 0, 'either way the retry budget is whole')
  assert.equal(afterInsert.last_error, null, 'no stale explanation survives')
  registry.dispose()
  cleanup(root)
})

test('a store that never wrote a revision keeps its reachable rebuild', () => {
  // `store_revision` is written only by the memories invalidate trigger, so a
  // store with no raw memory yet simply has no such meta row — the normal state
  // of a new store. `readRevision` reads that as 0, so an expectedRevision:0
  // rebuild is reachable and the next trigger revives it by id. The SQL must
  // agree: without COALESCE the subquery is NULL, `IS NOT` is true against
  // anything, and this row is deleted while still live. Every other test here
  // calls setRevision(), so none of them can reach this branch.
  const { root, registry, store } = setup()
  const now = Date.now()
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM meta WHERE k = 'store_revision'`).get().c,
    0,
    'precondition: the revision row genuinely does not exist',
  )
  insertFailed(store, 'live-rebuild', 'rebuild', { expectedRevision: 0 }, now)
  insertFailed(store, 'stale-rebuild', 'rebuild', { expectedRevision: 2 }, now)

  cleanupJobs(store, now)
  assert.deepEqual(
    idsIn(store),
    ['live-rebuild'],
    'a missing revision row means 0, not "matches nothing"',
  )
  registry.dispose()
  cleanup(root)
})

test('one malformed payload cannot cancel the rest of the cleanup pass', () => {
  // `json_extract` throws on non-JSON, and all three deletes share one
  // transaction, so an unreadable row would roll back the age-based cleanups
  // with it — and since `maintain` has no inner catch, the throw also takes out
  // pruneConversations, the decay enqueue and the rebuild trigger, every pass,
  // forever. No current writer produces such a row; the point is that a
  // maintenance statement must not be able to disable maintenance.
  const { root, registry, store } = setup()
  const now = Date.now()
  setRevision(store, 11)
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
         VALUES ('bad', 'rebuild', 'not json', 'failed', 6, 0, 0, ?),
                ('old-done', 'extract', '{}', 'done', 1, 0, 0, ?),
                ('stale-rebuild', 'rebuild', '{"expectedRevision":3}', 'failed', 6, 0, 0, ?)`,
      )
      .run(now, now - 40 * 86_400_000, now)
  })

  assert.doesNotThrow(() => cleanupJobs(store, now), 'a bad row must not abort the pass')
  assert.deepEqual(
    idsIn(store),
    ['bad'],
    'the aged done row and the superseded rebuild were still collected',
  )

  // The unreadable row is not kept forever either — it just waits for the age
  // line, the same fallback every kind without a readable revision gets.
  cleanupJobs(store, now + 31 * 86_400_000)
  assert.deepEqual(idsIn(store), [])
  registry.dispose()
  cleanup(root)
})
