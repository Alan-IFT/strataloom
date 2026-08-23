/** §10 store/migration domain: creation, atomicity, concurrency, guards, FTS. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { migrate, MigrationError } from '../lib/store/schema.js'
import { immediateTx } from '../lib/store/tx.js'
import { APPLICATION_ID, TARGET_USER_VERSION } from '../lib/constants.js'
import { StoreRegistry } from '../lib/store/store.js'
import { openRegistry, cleanup, tempRoot } from './helpers.mjs'

const openRaw = (path) => {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 2000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

const userVersion = (db) => Number(db.prepare('PRAGMA user_version').get().user_version)

test('fresh store migrates to target version with application_id', () => {
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db)
  assert.equal(userVersion(db), TARGET_USER_VERSION)
  assert.equal(
    Number(db.prepare('PRAGMA application_id').get().application_id),
    APPLICATION_ID,
  )
  db.close()
  cleanup(root)
})

test('migration is atomic: an injected failure rolls everything back', () => {
  const root = tempRoot()
  const path = join(root, 'm.sqlite')
  const db = openRaw(path)
  // Poison the migration by pre-creating a table v1 wants to create — inside
  // the lock the DDL throws, and the transaction must roll back wholesale.
  db.exec('CREATE TABLE memories (x INTEGER)')
  db.exec('PRAGMA user_version = 0')
  assert.throws(() => migrate(db))
  assert.equal(userVersion(db), 0)
  // The poison table is still there (rollback did not half-apply anything).
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
  assert.deepEqual(tables.map((t) => t.name), ['memories'])
  db.close()
  cleanup(root)
})

test('concurrent migration: second connection no-ops inside the lock (TOCTOU regression)', () => {
  const root = tempRoot()
  const path = join(root, 'm.sqlite')
  const a = openRaw(path)
  const b = openRaw(path)
  // Both plan a migration from scratch; a wins, b must empty-commit.
  migrate(a)
  migrate(b) // would throw "table already exists" if checked outside the lock
  assert.equal(userVersion(b), TARGET_USER_VERSION)
  a.close()
  b.close()
  cleanup(root)
})

test('v1 -> v2 -> v3 stepwise upgrade works', () => {
  const root = tempRoot()
  const path = join(root, 'm.sqlite')
  const db = openRaw(path)
  migrate(db, 'repo', 1)
  assert.equal(userVersion(db), 1)
  // v1 has no jobs table and no superseded_by column.
  assert.throws(() => db.prepare('SELECT * FROM jobs').all())
  migrate(db, 'repo', 2)
  assert.equal(userVersion(db), 2)
  db.prepare('SELECT id, kind, state FROM jobs').all()
  db.prepare('SELECT superseded_by FROM memories').all()
  // v2 has no conversations table yet
  assert.throws(() => db.prepare('SELECT * FROM conversations').all())
  migrate(db, 'repo', 3)
  assert.equal(userVersion(db), 3)
  db.prepare('SELECT session_id, turn, provenance FROM conversations').all()
  db.close()
  cleanup(root)
})

test('v4 -> v5 upgrade makes an EXISTING store invalidate on any write path', () => {
  // The real population is v4 stores in the field, whose rollups were only
  // retired by the tool write entry. The upgrade must retrofit the guarantee
  // onto data that already exists, not just onto freshly created stores.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 4)
  const now = Date.now()
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
    VALUES ('roll','fact','repo-local','active','summary','OLD','derived',${now},${now},1)`)
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
    VALUES ('m1','fact','repo-local','candidate','fresh','NEW','human',${now},${now})`)
  // v4: a raw pipeline-shaped write leaves the stale rollup in place.
  db.exec(`UPDATE memories SET status='active' WHERE id='m1'`)
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories WHERE derived=1`).get().c,
    1,
    'v4 is the buggy baseline: the summary survives a non-tool write',
  )

  migrate(db, 'repo', 5)
  assert.equal(userVersion(db), 5)
  // The same write now retires the summary, on the pre-existing data.
  db.exec(`UPDATE memories SET status='dormant' WHERE id='m1'`)
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories WHERE derived=1`).get().c,
    0,
    'after the upgrade, any authoritative change invalidates',
  )
  assert.ok(
    Number(db.prepare(`SELECT v FROM meta WHERE k='store_revision'`).get().v) > 0,
    'and the revision advances, so a queued rebuild is a distinct job',
  )
  db.close()
  cleanup(root)
})

test('foreign application_id is refused', () => {
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  db.exec('PRAGMA application_id = 999')
  db.exec('PRAGMA user_version = 1')
  assert.throws(() => migrate(db), MigrationError)
  db.close()
  cleanup(root)
})

test('newer store version is refused (no downgrade)', () => {
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db)
  db.exec('PRAGMA user_version = 99')
  assert.throws(() => migrate(db), /newer than supported/)
  db.close()
  cleanup(root)
})

test('CHECK constraints and repo guard enforce the domain enums', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const insert = (kind, visibility, status, provenance) =>
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 't', 'b', ?, 0, 0)`,
      )
      .run(Math.random().toString(36), kind, visibility, status, provenance)
  insert('fact', 'repo-local', 'active', 'human')
  assert.throws(() => insert('nope', 'repo-local', 'active', 'human'))
  assert.throws(() => insert('fact', 'repo-local', 'active', 'invented'))
  assert.throws(() => insert('fact', 'private', 'active', 'human'), /visibility does not match/)
  // guard also blocks UPDATE into private
  assert.throws(() =>
    store.db.exec(`UPDATE memories SET visibility = 'private'`),
  )
  registry.dispose()
  cleanup(root)
})

test('foreign keys are enforced (evidence -> memories)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  assert.throws(() =>
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES ('ghost', 'session', 's')`)
      .run(),
  )
  registry.dispose()
  cleanup(root)
})

test('FTS triggers keep the index consistent through insert/update/delete', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES ('m1', 'fact', 'repo-local', 'active', 'pnpm not npm', 'use pnpm here', 'human', 0, 0)`,
    )
    .run()
  const count = () =>
    store.db.prepare(`SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH 'pnpm'`).get().c
  assert.equal(count(), 1)
  store.db.prepare(`UPDATE memories SET title = 'yarn now', body = 'switched' WHERE id = 'm1'`).run()
  assert.equal(count(), 0)
  store.db.prepare(`DELETE FROM memories WHERE id = 'm1'`).run()
  store.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')`)
  registry.dispose()
  cleanup(root)
})

test('directory scan discovery opens existing stores and skips junk', () => {
  const { root, registry } = openRegistry()
  registry.open('known')
  registry.dispose()
  // junk dir without a db file must be skipped
  mkdirSync(join(root, 'repos', 'junk'), { recursive: true })
  const second = new (registry.constructor)(root, { warn() {}, info() {} })
  second.openAllKnown()
  assert.ok(second.get('known'))
  assert.equal(second.get('junk'), undefined)
  second.dispose()
  cleanup(root)
})

test('immediateTx: read-then-write succeeds under real cross-process contention', () => {
  const root = tempRoot()
  const path = join(root, 'm.sqlite')
  const a = openRaw(path)
  a.exec('CREATE TABLE t (x INTEGER)')
  a.exec('INSERT INTO t VALUES (1)')
  a.close()
  // A separate OS process grabs the write lock, signals via marker file,
  // holds it 300ms, updates, commits. Our synchronous immediateTx then waits
  // at BEGIN (busy_timeout) instead of failing — the deferred-BEGIN
  // BUSY_SNAPSHOT mode is structurally gone.
  const marker = join(root, 'locked')
  const child = spawn(process.execPath, [
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE t SET x = 2');
    fs.writeFileSync(${JSON.stringify(marker)}, '1');
    const until = Date.now() + 300; while (Date.now() < until) {}
    db.exec('COMMIT');
    db.close();
    `,
  ])
  // Synchronous wait for the child to hold the lock (event loop stays free of promises).
  const deadline = Date.now() + 5_000
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('child never took the lock')
    Atomics.wait(pause, 0, 0, 10)
  }
  const b = openRaw(path)
  immediateTx(b, () => {
    const row = b.prepare('SELECT x FROM t').get()
    b.prepare('UPDATE t SET x = ?').run(row.x + 1)
  })
  assert.equal(b.prepare('SELECT x FROM t').get().x, 3) // child's 2 + our 1
  b.close()
  child.kill()
  cleanup(root)
})

test('a real v1 store upgrades to the current version with its data intact', () => {
  // The stepwise test drives migrate() directly; this one is the user's
  // path: a store written by an older release, opened by this one. Data
  // written before the newer columns existed must survive untouched.
  const root = tempRoot()
  const dir = join(root, 'repos', 'old')
  mkdirSync(dir, { recursive: true })
  const legacy = openRaw(join(dir, 'memory.sqlite'))
  migrate(legacy, 'repo', 1)
  legacy
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES ('legacy1', 'fact', 'repo-local', 'active', 'old title', 'written under v1', 'human', 1, 1)`,
    )
    .run()
  legacy
    .prepare(`INSERT INTO evidence (memory_id, kind, ref, excerpt) VALUES ('legacy1','session','s1','quote')`)
    .run()
  legacy.close()

  const registry = new StoreRegistry(root, { warn() {}, info() {} })
  registry.openAllKnown()
  const store = registry.get('old')
  assert.ok(store, 'the old store opens rather than being refused')
  assert.equal(userVersion(store.db), TARGET_USER_VERSION)

  const row = store.db
    .prepare(`SELECT title, body, derived, human_confirmed, superseded_by FROM memories WHERE id = 'legacy1'`)
    .get()
  assert.equal(row.title, 'old title', 'pre-existing content is untouched')
  assert.equal(row.derived, 0, 'columns added later take their defaults')
  assert.equal(row.superseded_by, null)
  assert.equal(
    store.db.prepare(`SELECT excerpt FROM evidence WHERE memory_id = 'legacy1'`).get().excerpt,
    'quote',
  )
  // Tables introduced by later versions exist and are usable.
  assert.equal(store.db.prepare(`SELECT count(*) c FROM conversations`).get().c, 0)
  store.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')`)
  registry.dispose()
  cleanup(root)
})
