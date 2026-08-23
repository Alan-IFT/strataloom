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
