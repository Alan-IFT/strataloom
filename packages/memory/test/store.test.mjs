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
import {
  queryAllMemories,
  queryInjectableSet,
  queryPersonaSources,
  queryRecallRows,
  toFtsPhrase,
} from '../lib/store/fts.js'
import {
  DERIVED_LAYERS,
  DERIVED_PROVENANCE,
  INJECTABLE_PROVENANCE,
  LAYER,
  MEMORY_STATUSES,
  PROVENANCES,
} from '../lib/types.js'
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

test('v5 -> v6 rebuilds the memories table without losing evidence or guards', () => {
  // v6 widens the kind CHECK, which SQLite can only do by rebuilding the
  // table. Two things make that dangerous, and both are load-bearing:
  // `evidence.memory_id` cascades on delete (dropping the old table with
  // foreign keys ON erases every provenance row — D3), and nine triggers plus
  // the FTS index hang off this table. This is the upgrade real users take.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 5)
  const now = Date.now()
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
    VALUES ('keep','fact','repo-local','active','existing fact','body text','human',${now},${now})`)
  db.exec(`INSERT INTO evidence (memory_id,kind,ref,excerpt) VALUES ('keep','session','sess-1','the exact words')`)
  db.exec(`INSERT INTO conversations (session_id,seq,turn,label,provenance,text,created_at)
    VALUES ('sess-1',1,1,'user','human','original turn',${now})`)

  migrate(db, 'repo', 6)
  assert.equal(userVersion(db), 6)

  // Nothing was lost, including the quote that makes provenance checkable.
  assert.equal(db.prepare(`SELECT count(*) c FROM memories`).get().c, 1)
  assert.equal(db.prepare(`SELECT count(*) c FROM conversations`).get().c, 1)
  assert.equal(
    db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='keep'`).get()?.excerpt,
    'the exact words',
    'ON DELETE CASCADE must not fire during the rebuild',
  )
  // The FTS external-content index still resolves against the new table.
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH '"existing fact"'`).get().c,
    1,
  )
  // Every trigger came back: FTS sync (3), visibility guard (2), derived
  // status guard (2 — UPDATE and INSERT, since v11), D9 invalidation (3).
  //
  // A rebuild reinstalls the LIVE set (`createMemoryTriggers`), not the set of
  // the version being migrated to, so this count tracks today's schema rather
  // than v6's. That is the deliberate consequence of having one definition:
  // the number moves when the live set does.
  assert.equal(
    db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='trigger'`).get().c,
    10,
  )

  // The point of the migration: the new kind is accepted, unknown ones are not.
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
    VALUES ('new','coding','repo-local','active','a lesson','travels between repos','human',${now},${now})`)
  assert.throws(() =>
    db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
      VALUES ('bad','bogus','repo-local','active','t','b','human',${now},${now})`),
  )
  // D9 survived the rebuild: writing a non-derived row advanced the revision.
  assert.ok(Number(db.prepare(`SELECT v FROM meta WHERE k='store_revision'`).get().v) > 0)
  db.close()
  cleanup(root)
})

test('v6 -> v7 widens derived to a layer and carries the guards across', () => {
  // Phase 2 needs no new table: L2/L3 are rows at a higher `derived` level.
  // The rebuild must therefore keep the data AND come back with triggers whose
  // semantics now span every layer, so a scenario block cannot outlive the set
  // it summarizes.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 6)
  const now = Date.now()
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
    VALUES ('raw','fact','repo-local','active','a raw fact','body','human',${now},${now})`)
  db.exec(`INSERT INTO evidence (memory_id,kind,ref,excerpt) VALUES ('raw','session','s1','the words')`)
  // v6 can only express the boolean rollup.
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
    VALUES ('old-sum','fact','repo-local','active','old summary','b','derived',${now},${now},1)`)
  assert.throws(
    () => db.exec(`UPDATE memories SET derived = 2 WHERE id = 'old-sum'`),
    'v6 is the baseline: a scenario layer cannot yet be expressed',
  )

  migrate(db, 'repo', 7)
  assert.equal(userVersion(db), 7)
  assert.equal(db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='raw'`).get()?.excerpt, 'the words')
  // 10 as of v11 — the rebuild reinstalls the live set, which now guards the
  // derived layer on INSERT as well as UPDATE.
  assert.equal(db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='trigger'`).get().c, 10)

  // The new layers are now expressible, and nonsense is still refused.
  db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
    VALUES ('sc','fact','repo-local','active','a scenario','b','derived',${now},${now},2)`)
  assert.throws(() =>
    db.exec(`INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
      VALUES ('bad','fact','repo-local','active','t','b','derived',${now},${now},9)`),
  )
  // A derived row of any layer still cannot be aged out row by row.
  assert.throws(() => db.exec(`UPDATE memories SET status='dormant' WHERE id='sc'`))

  // D9 now spans layers: touching the raw set clears the scenario too.
  db.exec(`UPDATE memories SET title='edited' WHERE id='raw'`)
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c,
    0,
    'the widened triggers retire every layer, not just the old boolean rollup',
  )
  db.close()
  cleanup(root)
})

test('v7 -> v8 keeps queued work and records why a job failed', () => {
  // A dead letter used to be unattributable once the log rotated, which is
  // exactly when someone comes asking. The cause now rides the row.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 7)
  db.exec(`INSERT INTO jobs (id,kind,payload,state,attempts,run_after,created_at,completed_at)
    VALUES ('old','rebuild','{}','failed',6,0,0,1)`)

  migrate(db, 'repo', 8)
  assert.equal(userVersion(db), 8)
  const carried = db.prepare(`SELECT state, attempts, last_error FROM jobs WHERE id='old'`).get()
  assert.equal(carried.state, 'failed', 'existing rows survive the upgrade')
  assert.equal(carried.attempts, 6)
  assert.equal(carried.last_error, null, 'a job that failed before v8 has no recorded cause')

  db.exec(`UPDATE jobs SET last_error = 'StrataloomPipelineLlmError: stream finished as max-tokens'
           WHERE id='old'`)
  assert.match(
    db.prepare(`SELECT last_error FROM jobs WHERE id='old'`).get().last_error,
    /max-tokens/,
  )
  db.close()
  cleanup(root)
})

test('v8 -> v9 retokenizes the index so Chinese is found by re-wording', () => {
  // The live failure this fixes: the default tokenizer emits one token per
  // CJK run between punctuation, so a query matched only when it equalled a
  // whole run. A natural re-wording — any substring of what is stored — missed
  // a memory sitting right there.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 8)
  const now = Date.now()
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
     VALUES ('zh','coding','repo-local','active',?,?,'human',?,?)`,
  ).run('检索中文记忆用连续词组，空格分词会变成 AND 而落空', 'FTS5 建表没有配置中文分词器。', now, now)
  // A short Latin identifier, the case a trigram index would have broken.
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
     VALUES ('en','fact','repo-local','active',?,?,'human',?,?)`,
  ).run('CI runs on Go', 'the CI job builds with Go and npm', now, now)

  // Query through the SAME builder the recall path uses: the stored expansion
  // and the query expansion are two halves of one rule, so testing the index
  // with a hand-rolled phrase would prove nothing about real recall.
  const hits = (text) =>
    db
      .prepare(`SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH ?`)
      .get(toFtsPhrase(text)).c

  // Under the old tokenizer a CJK run between punctuation is ONE token, so
  // only a query equal to a whole such run could match. These are all
  // substrings of what is stored, and all missed it.
  for (const missed of ['分词器', '空格分词', '中文记忆', '落空']) {
    assert.equal(hits(missed), 0, `the old index could not find ${missed}`)
  }
  assert.equal(hits('CI'), 1, 'short Latin worked before and must keep working')

  migrate(db, 'repo', 9)
  assert.equal(userVersion(db), 9)
  for (const found of ['分词器', '空格分词', '中文记忆', '落空']) {
    assert.equal(hits(found), 1, `a re-worded query now reaches the memory: ${found}`)
  }
  assert.equal(hits('检索中文记忆用连续词组'), 1, 'the verbatim query keeps working')
  // The reason this is bigrams and not trigrams: two-character words are the
  // common case in Chinese, and short Latin identifiers must not regress.
  assert.equal(hits('落空'), 1, 'a two-character word is findable')
  assert.equal(hits('CI'), 1, 'short Latin still resolves — no trigram regression')

  // Escaping, operators-as-words and the index/table agreement are unchanged.
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
     VALUES ('ops','fact','repo-local','active',?,?,'human',?,?)`,
  ).run('quote "handling"', 'AND OR NOT are plain words here', now, now)
  assert.equal(hits('AND OR NOT'), 1, 'FTS operators stay literal text')
  assert.equal(hits('quote "handling"'), 1)
  // Every memory is indexed — the contentless index's version of the old
  // external-content 'integrity-check'.
  assert.equal(
    db.prepare(
      `SELECT count(*) c FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.rowid = m.rowid)`,
    ).get().c,
    0,
  )
  db.close()
  cleanup(root)
})

test('v9 -> v10 makes "a derived row carries derived provenance" a property of the data', () => {
  // Two columns state one fact and only one was checked. `derived != RAW` says
  // a row IS generated output; `provenance = 'derived'` says it CAME FROM the
  // generator. §2.3's trust filter is written against the second, while
  // `queryInjectionRows` selects its derived branch on the FIRST — so a row
  // holding one without the other rides the layer column past the filter.
  //
  // The assertion below is that the state is UNREACHABLE, not that some query
  // hides it. A `provenance` filter on the injection query would leave the row
  // stored, and `queryRecallRows` admits every provenance by design, so
  // `memory_recall` would serve it anyway.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 9)
  const now = Date.now()
  const insert = (id, provenance, layer) =>
    db
      .prepare(
        `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
         VALUES (?,'fact','repo-local','active',?,'b',?,?,?,?)`,
      )
      .run(id, `title ${id}`, provenance, now, now, layer)
  const violations = () =>
    db.prepare(
      `SELECT count(*) c FROM memories WHERE derived != ${LAYER.RAW} AND provenance != ?`,
    ).get(DERIVED_PROVENANCE).c

  // Precondition at v9, and the reason a read-path filter was not enough: the
  // bad state is reachable by a bare UPDATE and it PERSISTS. D9's
  // `invalidate_derived_update` fires on `OLD.derived = RAW`, so rewriting the
  // provenance of an ALREADY derived row trips no trigger at all.
  insert('roll', DERIVED_PROVENANCE, LAYER.SCENARIO)
  const revisionBefore = db.prepare(`SELECT v FROM meta WHERE k='store_revision'`).get()?.v
  const changed = Number(
    db.prepare(`UPDATE memories SET provenance = 'tool-output' WHERE derived != 0`).run()
      .changes,
  )
  assert.equal(changed, 1, 'precondition: v9 accepts the rewrite')
  assert.equal(violations(), 1, 'precondition: and the contradicting row is STORED')
  assert.equal(
    db.prepare(`SELECT v FROM meta WHERE k='store_revision'`).get()?.v,
    revisionBefore,
    'no invalidation trigger responds — the guard watches OLD.derived = RAW',
  )
  db.exec(`DELETE FROM memories`)

  migrate(db, 'repo', 10)
  assert.equal(userVersion(db), 10)

  // Accepted, half 1. These rows are also the FIXTURE route 3 promotes below,
  // so the loop runs regardless of what is being asserted. What it establishes
  // is that a RAW row still takes ANY provenance — the constraint bounds the
  // derived layer instead of freezing the column.
  //
  // Stated as measured rather than as a claim about mutation coverage: with
  // both `assert.equal`s here deleted and only these loops kept, every mutant
  // tried is still killed (dropped conjunct, inverted predicate, unregistered
  // migration, whole column frozen), because an over-tight CHECK makes the
  // fixture INSERT itself throw. These two assertions say what the loops mean;
  // they are not what traps those mutants.
  for (const provenance of PROVENANCES) {
    insert(`raw-${provenance}`, provenance, LAYER.RAW)
  }
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories`).get().c,
    PROVENANCES.length,
    'every provenance is still writable at the raw layer',
  )

  // Accepted, half 2, and the fixture route 2 rewrites: a well-formed derived
  // row still writes at EVERY layer the enum admits, so a layer added later
  // inherits the rule instead of needing a line here.
  for (const layer of DERIVED_LAYERS) {
    insert(`ok-${layer}`, DERIVED_PROVENANCE, layer)
  }
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories WHERE derived != ${LAYER.RAW}`).get().c,
    DERIVED_LAYERS.length,
    'the migration must not make the derived layer unwritable',
  )

  // Route 1 — INSERT, over the enums rather than a written-out list: a copy of
  // PROVENANCES here would stop covering the enum the day it grows.
  for (const provenance of PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE)) {
    for (const layer of DERIVED_LAYERS) {
      assert.throws(
        () => insert(`bad-${provenance}-${layer}`, provenance, layer),
        /CHECK constraint failed/,
        `INSERT at layer ${layer} with provenance '${provenance}' must be refused`,
      )
    }
  }

  // Route 2 — rewrite the provenance of a STORED derived row. This is the
  // route measured above as persistent at v9.
  for (const provenance of PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE)) {
    assert.throws(
      () =>
        db.prepare(`UPDATE memories SET provenance = ? WHERE derived != 0`).run(provenance),
      /CHECK constraint failed/,
      `a stored derived row cannot be relabelled '${provenance}'`,
    )
  }

  // Route 3 — promote a low-trust RAW row INTO the derived layer.
  for (const provenance of PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE)) {
    for (const layer of DERIVED_LAYERS) {
      assert.throws(
        () =>
          db
            .prepare(`UPDATE memories SET derived = ? WHERE id = ?`)
            .run(layer, `raw-${provenance}`),
        /CHECK constraint failed/,
        `a '${provenance}' row cannot be promoted to layer ${layer}`,
      )
    }
  }

  // The sentence the read path is now entitled to assume, over the whole table.
  assert.equal(violations(), 0)
  db.close()
  cleanup(root)
})

test('v10 -> v11 makes "a derived row is only ever active" the whole sentence', () => {
  // v4 stated the principle in a comment — regenerated wholesale, never aged
  // out row by row — and enforced `dormant` alone. The precondition below
  // measures what that actually covered: 1 of the 5 non-active statuses.
  //
  // It matters because the injection read path LEANS on the property, and the
  // derived branch of `queryInjectionRows` is a SHORT-CIRCUIT — one non-active
  // derived row does not merely add itself to the packet, it shadows the whole
  // raw set behind it.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 10)
  const now = Date.now()
  const insert = (id, status, layer, provenance = DERIVED_PROVENANCE) =>
    db
      .prepare(
        `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
         VALUES (?,'fact','repo-local',?,?,'b',?,?,?,?)`,
      )
      .run(id, status, `title ${id}`, provenance, now, now, layer)
  const nonActive = MEMORY_STATUSES.filter((s) => s !== 'active')

  // The fixture is a store as it EXISTS ON DISK at v10, which is not what
  // `migrate(db,'repo',10)` alone produces. `migrateV10` rebuilds the table and
  // therefore reinstalls the LIVE trigger set, so a store migrated by today's
  // build already carries v11's guard before v11 runs. Real v10 stores — all
  // nine live ones — were written by the PREVIOUS release and carry the v4-era
  // `guard_derived_dormant`. Restoring it here is what makes this an upgrade
  // test rather than a test of a store that never existed.
  //
  // This is also the measured reason `migrateV11` drops by
  // `DROP TRIGGER IF EXISTS` on BOTH names: the two arrival paths genuinely
  // carry different triggers, and a bare DROP of either name fails on the
  // other.
  db.exec(`
    DROP TRIGGER IF EXISTS guard_derived_status;
    DROP TRIGGER IF EXISTS guard_derived_status_insert;
    CREATE TRIGGER guard_derived_dormant BEFORE UPDATE OF status, derived ON memories
      WHEN new.status = 'dormant' AND new.derived != ${LAYER.RAW}
      BEGIN SELECT RAISE(ABORT, 'a derived rollup cannot go dormant'); END;
  `)

  // Data that must survive the migration untouched, including the evidence row
  // whose cascade a table rebuild would have endangered — the reason this
  // migration is pure trigger DDL and rebuilds nothing.
  //
  // These RAW rows go in BEFORE the derived row, and the order is not
  // cosmetic: D9 has three triggers, and `invalidate_derived_insert` deletes
  // the entire derived layer on any raw INSERT. Planting the summary first
  // means it is already gone before the assertions run — which is precisely how
  // this test failed when it was first written.
  insert('raw-keep', 'active', LAYER.RAW, 'human')
  db.prepare(
    `INSERT INTO evidence (memory_id,kind,ref,excerpt) VALUES ('raw-keep','session','s1','the exact words')`,
  ).run()

  // Precondition, stated over the enum rather than a list of five: the old
  // guard names ONE status, so every other one is accepted on a derived row and
  // the row PERSISTS. D9 does not fire on these UPDATEs — it watches
  // `OLD.derived = RAW`, and this row is already derived. This is the defect,
  // measured.
  insert('roll', 'active', LAYER.SCENARIO)
  const acceptedAtV10 = nonActive.filter((status) => {
    try {
      db.prepare(`UPDATE memories SET status = ? WHERE id = 'roll'`).run(status)
      db.prepare(`UPDATE memories SET status = 'active' WHERE id = 'roll'`).run()
      return true
    } catch {
      return false
    }
  })
  assert.deepEqual(
    acceptedAtV10,
    nonActive.filter((s) => s !== 'dormant'),
    'precondition: v10 guards `dormant` alone and accepts every other non-active status',
  )

  const before = {
    memories: db.prepare(`SELECT count(*) c FROM memories`).get().c,
    evidence: db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='raw-keep'`).get().excerpt,
  }

  migrate(db, 'repo', 11)
  assert.equal(userVersion(db), 11)

  // Data is intact and the index still resolves — a rebuild's hazards, checked
  // even though this migration deliberately avoids a rebuild.
  assert.equal(db.prepare(`SELECT count(*) c FROM memories`).get().c, before.memories)
  assert.equal(
    db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='raw-keep'`).get().excerpt,
    before.evidence,
    'no evidence row may be lost',
  )
  assert.equal(
    db.prepare(`SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH '"title raw-keep"'`)
      .get().c,
    1,
    'the FTS index still matches the surviving row',
  )
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)

  // The permissive trigger is GONE, not merely shadowed by a stricter one.
  // Asserting absence by name is what catches a migration that adds the new
  // guard while leaving the old one behind.
  assert.equal(
    db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='trigger' AND name='guard_derived_dormant'`).get().c,
    0,
    'the permissive v4 trigger must be dropped, not left alongside',
  )

  // And the new constraint is in force over the WHOLE enum.
  for (const status of nonActive) {
    assert.throws(
      () => db.prepare(`UPDATE memories SET status = ? WHERE id = 'roll'`).run(status),
      /cannot leave active/,
      `after v11 a derived row must not reach '${status}'`,
    )
  }
  const kept = db.prepare(`SELECT status, derived FROM memories WHERE id = 'roll'`).get()
  assert.equal(kept?.status, 'active', 'the refused row survives — a refusal, not a deletion')
  assert.equal(kept?.derived, LAYER.SCENARIO, 'and is still a scenario block')
  // Reverse discrimination: raw rows keep their whole lifecycle.
  for (const status of MEMORY_STATUSES) {
    db.prepare(`UPDATE memories SET status = ? WHERE id = 'raw-keep'`).run(status)
  }
  db.close()
  cleanup(root)
})

test('the LIVE trigger set carries the v11 rule, not just the v11 migration', () => {
  // Two definitions of `guard_derived_status` exist by design: the frozen one
  // in `migrateV11`, and the live one in `createMemoryTriggers` that every
  // table rebuild reinstalls. On a current store the migration runs LAST, so
  // its copy wins and the live definition is invisible to every other test —
  // measured: reverting the live definition to the old `dormant`-only rule
  // leaves the entire suite green (261/261).
  //
  // That gap is not theoretical. `rebuildMemories` reinstalls the LIVE set, so
  // the next migration that widens any CHECK silently re-installs whatever the
  // live definition says — the same "one definition, applied to a freshly
  // rebuilt table" mechanism this file's header describes. A weakened live
  // definition would therefore reopen the defect at the next rebuild, with no
  // test objecting.
  //
  // Reaching it needs a store whose LAST schema step was a rebuild, which is
  // what `target = 10` produces: `migrateV10` calls `rebuildMemories`, and no
  // later migration overwrites its triggers.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 10)
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
     VALUES ('sc','fact','repo-local','active','a scenario','b',?,0,0,?)`,
  ).run(DERIVED_PROVENANCE, LAYER.SCENARIO)
  for (const status of MEMORY_STATUSES.filter((s) => s !== 'active')) {
    assert.throws(
      () => db.prepare(`UPDATE memories SET status = ? WHERE id = 'sc'`).run(status),
      /cannot leave active/,
      `the live trigger set must refuse '${status}' on a derived row`,
    )
  }

  // The PROMOTE route as well, or this test only covers one of the two
  // execution points the shared column list carries. Measured: dropping
  // `derived` from that list in the LIVE definition alone leaves the whole
  // suite green without these lines — T2 catches it only through the frozen
  // copy in `migrateV11`, so the live definition needs its own check on the
  // very route the column list exists for.
  for (const status of MEMORY_STATUSES.filter((s) => s !== 'active')) {
    const id = `promote-${status}`
    db.prepare(
      `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
       VALUES (?,'fact','repo-local',?,'t','b','human',0,0,?)`,
    ).run(id, status, LAYER.RAW)
    assert.throws(
      () =>
        db
          .prepare(`UPDATE memories SET derived = ?, provenance = ? WHERE id = ?`)
          .run(LAYER.SCENARIO, DERIVED_PROVENANCE, id),
      /cannot leave active/,
      `the live trigger set must refuse promoting a '${status}' row into the layer`,
    )
    // Refused, not deleted — the distinction the column list actually buys.
    assert.equal(
      db.prepare(`SELECT derived FROM memories WHERE id = ?`).get(id)?.derived,
      LAYER.RAW,
      `the refused row survives at RAW ('${status}')`,
    )
  }

  // The THIRD execution point, which had no behavioural test at all. The two
  // loops above cover the routes the shared `OF status, derived` column list
  // carries; `guard_derived_status_insert` is a SEPARATE trigger, and it was
  // exercised only through `migrateV11`'s frozen copy (T2) — never through the
  // live definition that `rebuildMemories` reinstalls.
  //
  // What hid the gap is that the existing defence COUNTS triggers instead of
  // exercising them. Deleting this trigger outright changes the count, and the
  // v5→v6 / v6→v7 migration tests catch that; but keeping the NAME while
  // gutting its WHEN clause keeps the count correct and passed the whole suite.
  // Measured with the live definition reverted to `dormant`-only: 263/263/0
  // green, while 4 of the 5 non-active statuses were ACCEPTED and 4 bad rows
  // persisted. A count is not a behaviour.
  for (const status of MEMORY_STATUSES.filter((s) => s !== 'active')) {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
             VALUES (?,'fact','repo-local',?,'t','b',?,0,0,?)`,
          )
          .run(`born-${status}`, status, DERIVED_PROVENANCE, LAYER.SCENARIO),
      /must be born active/,
      `the live trigger set must refuse a derived row born '${status}'`,
    )
  }
  db.close()
  cleanup(root)
})

test('a store opened at the DEFAULT target refuses a mislabelled derived row', () => {
  // The test above migrates to 10 EXPLICITLY, so it proves `migrateV10` works
  // while saying nothing about whether stores ever REACH it. Leaving
  // `TARGET_USER_VERSION` at 9 with the migration written and registered was
  // measured to keep the entire suite green: the constraint would never be
  // applied to a real store, the injection defect would stand back open, and
  // CI would report success. "The guard is written correctly" and "the guard is
  // in force" are two claims, and only the second one protects anyone.
  //
  // So this opens a store the way production does — default target, no version
  // argument — and asserts the OUTCOME. Note what it deliberately does NOT do:
  // `assert.equal(userVersion(db), TARGET_USER_VERSION)` reads the same symbol
  // on both sides and passes at any value, including 9.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo')
  const insert = (id, provenance, layer) =>
    db
      .prepare(
        `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
         VALUES (?,'fact','repo-local','active',?,'b',?,0,0,?)`,
      )
      .run(id, `title ${id}`, provenance, layer)
  for (const provenance of PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE)) {
    assert.throws(
      () => insert(`bad-${provenance}`, provenance, LAYER.SCENARIO),
      /CHECK constraint failed/,
      `a default-target store must refuse a derived row labelled '${provenance}'`,
    )
  }
  insert('ok', DERIVED_PROVENANCE, LAYER.SCENARIO)
  db.close()
  cleanup(root)
})

/**
 * The guards raise ABORT, and ABORT is a DECISION rather than a default.
 *
 * `RAISE(ABORT)` undoes the offending STATEMENT and leaves the surrounding
 * transaction alive and committable. `RAISE(ROLLBACK)` tears the whole
 * transaction down at the point of the raise. Both refuse the write, so both
 * satisfy every other assertion in the suite — measured: swapping the verb left
 * 264/264/0 green.
 *
 * The difference is exactly what ADR 0006 is about. The pipeline commits a
 * job's business writes and its OWN bookkeeping in one transaction (D6), so
 * under ROLLBACK a single refused row destroys the job row beside it and the
 * enclosing COMMIT fails. Measured directly: with ROLLBACK the `jobs` row is
 * gone, with ABORT both survive. `reconcile.ts` argues at length that one bad
 * id must not take down work that is independently fine — an argument that
 * holds only while the verb stays ABORT, and nothing was pinning the verb.
 *
 * Run against BOTH copies of the guard, for the reason the live-set test above
 * exists: a store at the current target carries `migrateV11`'s frozen copy, so
 * a version of this test written only against `openRegistry()` would leave the
 * live definition unpinned. Measured — swapping the verb in the live definition
 * ALONE survived that version of this test.
 *
 * Note the fixture order, the D9 trap this release keeps re-teaching: the
 * unrelated write in the transaction targets `jobs`, not `memories`. Any raw
 * write to `memories` here would fire `invalidate_derived_update` and delete
 * the very row meant to be refused, and the test would pass without the guard
 * ever firing.
 */
for (const [label, target] of [
  ['the live definition (last step is a rebuild)', 10],
  ['the v11 migration copy (current target)', undefined],
]) {
  test(`derived guards ABORT the statement, never ROLLBACK the transaction — ${label}`, () => {
    const root = tempRoot()
    const db = openRaw(join(root, 'm.sqlite'))
    migrate(db, 'repo', target)
    db.prepare(
      `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
       VALUES ('sc','fact','repo-local','active','a scenario','b',?,0,0,?)`,
    ).run(DERIVED_PROVENANCE, LAYER.SCENARIO)

    db.exec('BEGIN IMMEDIATE')
    // The job bookkeeping that shares this transaction with the business write.
    db.prepare(
      `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at)
       VALUES ('j1','reconcile','{}','done',1,0,0)`,
    ).run()
    assert.throws(
      () => db.prepare(`UPDATE memories SET status = 'superseded' WHERE id = 'sc'`).run(),
      /cannot leave active/,
      'the refused write still raises',
    )
    // Under ROLLBACK the transaction is already gone here, so this COMMIT
    // throws "no transaction is active"; under ABORT it is alive and commits.
    db.exec('COMMIT')

    assert.equal(
      db.prepare(`SELECT count(*) c FROM jobs WHERE id = 'j1'`).get().c,
      1,
      'a refused derived write must not destroy the unrelated work in its transaction',
    )
    assert.equal(
      db.prepare(`SELECT status FROM memories WHERE id = 'sc'`).get().status,
      'active',
      'and the refused row itself is unchanged',
    )
    db.close()
    cleanup(root)
  })
}

/**
 * An EXISTING v10 store, reopened the way production reopens one, must arrive
 * at v11 and be constrained.
 *
 * This test replaces one that opened a BRAND NEW store at the default target,
 * and the difference is the whole point. A new store is built by
 * `createMemoryTriggers`, which carries the v11 rule whatever
 * `TARGET_USER_VERSION` says — so the new-store route is guarded even when
 * `migrateV11` is never reached. Measured: with `TARGET_USER_VERSION` reverted
 * to 10, a new store stamps `user_version = 10` and STILL installs
 * `guard_derived_status`, so the old test stayed green and the whole suite read
 * 262/262 while every existing store went unprotected.
 *
 * The defect only shows on the OTHER route — a store already at v10, which is
 * what all nine production stores are. That route reaches the guard only if
 * `migrateV11` actually runs, so this is the route that pins the registration.
 *
 * The irony is worth recording: the replaced test's own comment predicted this
 * exact failure ("Leaving TARGET_USER_VERSION at 9 … was measured to keep the
 * entire suite green"), and then reached for the one fixture that cannot
 * observe it. The comment stated the principle; the code exercised something
 * else — the same shape as the defect this whole release fixes.
 */
test('an EXISTING v10 store, reopened at the default target, reaches v11 and is constrained', () => {
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))

  // A genuine v10 store, not `migrate(db,'repo',10)`'s output. That call runs
  // today's `createMemoryTriggers` and therefore already carries v11's guard;
  // a real v10 store was written by the PREVIOUS release and carries v4's
  // `guard_derived_dormant`. Restoring it is what makes this an upgrade.
  migrate(db, 'repo', 10)
  db.exec(`
    DROP TRIGGER IF EXISTS guard_derived_status;
    DROP TRIGGER IF EXISTS guard_derived_status_insert;
    CREATE TRIGGER guard_derived_dormant BEFORE UPDATE OF status, derived ON memories
      WHEN new.status = 'dormant' AND new.derived != ${LAYER.RAW}
      BEGIN SELECT RAISE(ABORT, 'a derived rollup cannot go dormant'); END;
  `)
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
     VALUES ('sc','fact','repo-local','active','a scenario','b',?,0,0,?)`,
  ).run(DERIVED_PROVENANCE, LAYER.SCENARIO)

  // Precondition: on the store as it exists today, aging out is ACCEPTED.
  db.prepare(`UPDATE memories SET status = 'superseded' WHERE id = 'sc'`).run()
  assert.equal(
    db.prepare(`SELECT status FROM memories WHERE id = 'sc'`).get().status,
    'superseded',
    'precondition: a real v10 store lets a derived row be aged out',
  )
  db.prepare(`UPDATE memories SET status = 'active' WHERE id = 'sc'`).run()

  // Reopen exactly as production does: default target, no version argument.
  migrate(db, 'repo')

  // The OUTCOME, not the version number. Deliberately not
  // `assert.equal(userVersion(db), TARGET_USER_VERSION)`: that reads the same
  // symbol on both sides and passes at any value, including 10.
  for (const status of MEMORY_STATUSES.filter((s) => s !== 'active')) {
    assert.throws(
      () => db.prepare(`UPDATE memories SET status = ? WHERE id = 'sc'`).run(status),
      /cannot leave active/,
      `an upgraded store must refuse to move a derived row to '${status}'`,
    )
  }
  // And the permissive trigger is gone by name, so this cannot pass merely
  // because some other guard happened to object.
  assert.equal(
    db.prepare(
      `SELECT count(*) c FROM sqlite_master WHERE type='trigger' AND name='guard_derived_dormant'`,
    ).get().c,
    0,
    'the v4 trigger must be dropped by the upgrade',
  )
  db.close()
  cleanup(root)
})

test('the stored bigrams and the query bigrams are the same rule', () => {
  // The expansion exists twice by necessity — SQL on write, JS on read. If the
  // two ever disagree, Chinese recall breaks silently, so assert they agree on
  // the same input rather than trusting that both were edited together.
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo')
  const now = Date.now()
  const text = '少就是多，删除优于完善'
  db.prepare(
    `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
     VALUES ('a','fact','repo-local','active',?,'','human',?,?)`,
  ).run(text, now, now)

  const storedTokens = new Set(
    db.prepare(`SELECT cjk FROM memories_fts`).get().cjk.split(' ').filter(Boolean),
  )
  // Every bigram the reader would search for must be one the writer stored.
  for (const token of toFtsPhrase(text).split(' AND ')) {
    const bare = token.slice(1, -1)
    if (!/[\u3400-\u9fff]/.test(bare)) continue
    assert.ok(storedTokens.has(bare), `query bigram ${bare} is not in the index`)
  }
  db.close()
  cleanup(root)
})

/**
 * One row of `memories`, with every column this domain varies exposed as an
 * option. Written as one helper rather than three (`insertActive` /
 * `insertDormant` / `insertDerived`) on purpose: the whole point below is that
 * layer, status and provenance are three INDEPENDENT axes of one predicate, and
 * per-shape helpers would hide which axis a fixture row is exercising.
 *
 * `provenance` carries NO default. A default is a value every row inherits
 * without stating a reason, and provenance is precisely the axis this domain
 * got wrong once already: `queryAllMemories` is the ONE member of its family
 * that omits `provenance IN (INJECTABLE_LIST)` — `queryInjectableSet` and
 * `queryPersonaSources` both carry it — so a fixture that never varies
 * provenance cannot tell the omission from an oversight. Requiring the column
 * forces every row below to name the provenance it exists to exercise.
 */
const insertMemory = (store, { id, title, at, provenance, status = 'active', derived = LAYER.RAW }) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', 'repo-local', ?, ?, 'body', ?, 0, ?, ?)`,
    )
    .run(id, status, title, provenance, at, derived)

/**
 * Human-readable layer names, so a failing case names the layer that escaped.
 *
 * Taken from `types.ts`'s own wording on each `LAYER` member, not invented.
 * `SUMMARY` is deliberately NOT called "L1": that number belongs to `RAW` ("L1
 * — an original memory"), and `types.ts` pointedly withholds an L-number from
 * `SUMMARY`, describing it only as "the pre-L2 rollup". A display name that
 * numbers it anyway would teach a reader of a FAILING test the wrong map of the
 * very layers the failure is about.
 */
const LAYER_NAMES = {
  [LAYER.SUMMARY]: 'pre-L2 rollup',
  [LAYER.SCENARIO]: 'L2 scenario',
  [LAYER.PERSONA]: 'L3 portrait',
}

/** Every lifecycle state `status = 'active'` is there to exclude — all five. */
const NON_ACTIVE_STATUSES = MEMORY_STATUSES.filter((status) => status !== 'active')

/**
 * `queryAllMemories` is the read behind `service.list()` — the "what have you
 * been remembering about me?" surface. All three properties of its WHERE clause
 * (`status = 'active'`, `derived = LAYER.RAW`, and the absence of a provenance
 * filter) had NO test in this domain; the only thing holding any of it was a
 * single reconcile-side case whose fixtures build L2 and nothing else. Measured
 * under exactly that regime, widening the layer conjunct to `derived !=
 * LAYER.SCENARIO` — which lets an L1 rollup and the L3 portrait straight
 * through — left the whole suite green at 265/265/0, and so did `derived <=
 * LAYER.SUMMARY`. Deleting `status = 'active' AND` outright survived too.
 *
 * The gap is reachable today, not theoretical. `list()` reads the GLOBAL store,
 * which is exactly where the L3 portrait lives, and the live global store
 * carries one. Leaked, that row is displayed beside `command.ts`'s "Remove one
 * with /memory forget <id>" while `forget` refuses every derived id — a user
 * shown a row whose only offered action cannot succeed.
 *
 * ONE TEST PER LAYER, each with its own clean store, never one store carrying
 * all three and never one `test()` looping over them. A loop is not three
 * execution points: the first failing layer throws and node:test reports one
 * result, so "L2 and L3 stayed green" — the part that says WHICH layer escaped —
 * would be unobservable. Registered as three separate `test()` calls,
 * `derived <= LAYER.SUMMARY` reds the L1 case alone and leaves L2/L3 green, and
 * that contrast IS the diagnosis. Which layer leaks is the whole subject here.
 */
for (const layer of DERIVED_LAYERS) {
  test(`queryAllMemories excludes derived layer ${layer} (${LAYER_NAMES[layer]}), every non-active status, and no provenance`, () => {
    const { root, registry } = openRegistry()
    const store = registry.open('k1')

    // The provenance axis, stated as a premise rather than trusted. This
    // fixture's surviving rows lean on `tool-output` being OUTSIDE the
    // injectable set; if §2.3 ever widened that set, the discrimination would
    // evaporate silently and this case would go on passing while testing less.
    assert.ok(
      !INJECTABLE_PROVENANCE.includes('tool-output'),
      'tool-output must be non-injectable, or this case no longer separates the ' +
        'review surface from the injection packet',
    )

    // D9's `invalidate_derived_insert/update/delete` delete the WHOLE derived
    // layer on any raw INSERT, UPDATE or DELETE, so every raw write in this
    // fixture comes first. The rule is not "the derived row is inserted last"
    // but "no raw write follows it".
    //
    // `updated_at` is assigned against `ORDER BY updated_at DESC` on purpose:
    // every row that must be EXCLUDED is given a HIGHER timestamp than every
    // row that must survive. Under `LIMIT` that is the only safe direction —
    // rows sorted last are the ones a shrinking limit silently drops, so
    // parking the excluded rows there would let `LIMIT` mask a real leak and
    // hand back a green test. Here a leak always lands at the head of the
    // result and no limit can hide it.
    //
    // Two surviving rows, not one, and their provenances differ deliberately.
    // `tool-output` is exactly what §2.3 keeps OUT of the injection packet, and
    // it is the case for this query not filtering by provenance at all: the
    // memories a user most needs to review are the ones the pipeline wrote
    // without being asked. A fixture whose only survivor were `human` would be
    // satisfied by `queryInjectableSet`'s predicate too, and so could not tell
    // the review surface from the injection surface.
    insertMemory(store, {
      id: 'raw-pipeline',
      title: 'learned from a tool result',
      at: 3000,
      provenance: 'tool-output',
    })
    insertMemory(store, { id: 'raw-human', title: 'a real memory', at: 2000, provenance: 'human' })
    // The status conjunct's own witnesses — ALL FIVE non-active states, not one
    // representative. `status = 'active'` excludes five states, and this repo
    // has already shipped the failure of testing one of five and calling the
    // set covered. The live global store alone holds `superseded` and
    // `tombstone` rows, neither of which a single `dormant` row speaks for.
    // These are RAW rows: `guard_derived_status_insert` forbids a non-active
    // derived row outright, which is why the two axes must be varied on
    // separate rows and can never be crossed on one.
    NON_ACTIVE_STATUSES.forEach((status, index) =>
      insertMemory(store, {
        id: `raw-${status}`,
        title: `a ${status} memory`,
        at: 8000 + index,
        provenance: 'human',
        status,
      }),
    )
    insertMemory(store, {
      id: `derived-${layer}`,
      title: `generated rollup at layer ${layer}`,
      at: 9000,
      provenance: DERIVED_PROVENANCE,
      derived: layer,
    })

    // The PREMISE, sampled where the query runs rather than assumed — the
    // lesson `derivedAtCommit` records in pipeline.test.mjs. Without it this
    // case is inert in two directions at once: drop the derived INSERT and
    // "only the raw active rows come back" is vacuously true, or misorder the
    // fixture so a raw write lands after it and D9 has silently emptied the
    // very layer under exclusion. One count closes both holes.
    assert.equal(
      store.db.prepare(`SELECT count(*) AS n FROM memories WHERE derived != ${LAYER.RAW}`).get().n,
      1,
      `the layer-${layer} row must REALLY be stored when the query runs — if D9 ` +
        'took it away, or it was never written, this case excludes nothing',
    )
    assert.equal(
      store.db.prepare(`SELECT count(*) AS n FROM memories WHERE status != 'active'`).get().n,
      NON_ACTIVE_STATUSES.length,
      `all ${NON_ACTIVE_STATUSES.length} non-active rows must really be stored too (layer ${layer})`,
    )

    assert.deepEqual(
      queryAllMemories(store, 50).map((row) => row.id),
      ['raw-pipeline', 'raw-human'],
      `the review surface must show both raw active rows and nothing else at layer ` +
        `${layer}: not the derived row (forget refuses every derived id, so listing ` +
        'it offers an action that must fail), and not the non-active ones (leaving ' +
        'every read surface IS what decay and supersession did to them) — while the ' +
        'pipeline-written row IS shown, because reviewing what was recorded ' +
        'unasked is the point of this surface',
    )
    registry.dispose()
    cleanup(root)
  })
}

/**
 * `EXCLUDED_STATUSES` drives exactly ONE read surface — `queryRecallRows` — and
 * until this case existed only 2 of its 5 members were held by anything.
 *
 * Measured before writing it, by deleting one status at a time from the array
 * and running the whole suite: `superseded` and `dormant` each turn a test red
 * (one recall assertion apiece, both incidental to that test's real subject),
 * while `tombstone`, `archived` and `candidate` all leave 310/310 green. The
 * three unguarded ones are not unreachable — each is merely MASKED by a second
 * mechanism that happens to hide the leak: `forget` blanks title and body in
 * the same transaction, so a tombstoned row has no text left for FTS to match;
 * `archived` is written only where `reconcile` supersedes a `procedure`, which
 * no test drives; and a `candidate` is normally reconciled into `active` or
 * `superseded` before any read happens. A mask is not the rule, and none of
 * the three would survive a change to the mechanism that hides it.
 *
 * So the fixture defeats every mask on purpose: the rows are written straight
 * to the table, so no `forget`/`reconcile` path gets to intervene, and all six
 * share ONE distinctive term, so FTS genuinely matches all six and the status
 * filter is the only thing that can separate them. The premise is asserted
 * rather than assumed — without the unfiltered count below, a fixture whose
 * term stopped matching would satisfy "only the active row comes back"
 * vacuously, which is precisely how the three masked statuses read as covered.
 *
 * Table-driven over `MEMORY_STATUSES` rather than a list of six literals: a
 * status added to the enum with no thought given to recall lands here as a
 * failure instead of passing unnoticed.
 */
test('recall exclusion table: queryRecallRows serves `active` alone, one row per status', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')

  // One term, shared by all six rows and used by nothing else in this file, so
  // the MATCH is common to every row and the WHERE clause is the only variable.
  const TERM = 'zarquon'
  MEMORY_STATUSES.forEach((status, index) =>
    insertMemory(store, {
      id: `recall-${status}`,
      title: `${TERM} ${status}`,
      at: 1000 + index,
      provenance: 'human',
      status,
    }),
  )

  // PREMISE: FTS really matches all six, so exclusion has something to exclude.
  // This is the assertion the three masked statuses never had — it is what
  // distinguishes "the filter removed it" from "there was nothing to remove".
  assert.equal(
    store.db
      .prepare(
        `SELECT count(*) AS n FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ?`,
      )
      .get(`"${TERM}"`).n,
    MEMORY_STATUSES.length,
    `all ${MEMORY_STATUSES.length} rows must be MATCHED by FTS before the status filter ` +
      'runs; if they are not, this case excludes nothing and passes vacuously',
  )

  assert.deepEqual(
    queryRecallRows(store, TERM, undefined).map((row) => row.id),
    ['recall-active'],
    'recall must serve the active row and no other: every non-active status is in ' +
      'EXCLUDED_STATUSES, and dropping any one of them from that array shows up HERE ' +
      'rather than being masked by forget blanking the text, by archived having no ' +
      'writer under test, or by a candidate being reconciled away first',
  )

  // The exclusion is the STATUS, not the kind filter or the term: the same
  // query with the kind these rows carry still returns the one active row.
  assert.deepEqual(
    queryRecallRows(store, TERM, 'fact').map((row) => row.id),
    ['recall-active'],
    'and the same holds with the kind filter engaged',
  )

  registry.dispose()
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

// ------------------------------------------- D9 source-set invalidation ----

/**
 * v12: D9 fires on a write to the derived layer's SOURCE SET, not on any raw
 * write at all.
 *
 * ⛔ ASSERTION A ALONE IS FALSE GREEN, AND THAT IS MEASURED, NOT FEARED.
 *
 * The natural test to write is "a surviving derived layer always matches the
 * sources it was built from" (A below). It is necessary and it is not
 * sufficient: an implementation that invalidates TOO MUCH satisfies it
 * perfectly. Reverting this change entirely — keeping v11's
 * `WHEN NEW.derived = RAW` with no source predicate — produces 0 violations of
 * A, because a layer destroyed on every write is never around to be stale. So
 * would `WHEN 1`.
 *
 * A therefore pins CORRECTNESS and can say nothing about the point of the
 * change. B pins the point: a write that CANNOT affect the layer must leave it
 * standing. Neither is redundant and neither is the safety property alone — A
 * without B admits the do-nothing implementation, B without A admits a trigger
 * that never fires. They are written as a pair and must stay one.
 *
 * C states the rule over the whole transition space, which is what separates
 * OLD ∪ NEW from either single side: 81 ordered transitions are visible only
 * to OLD and another 81 only to NEW.
 */

const revisionOf = (db) =>
  Number(db.prepare(`SELECT v FROM meta WHERE k = 'store_revision'`).get()?.v ?? 0)

const countDerived = (db) =>
  db.prepare(`SELECT count(*) AS n FROM memories WHERE derived != ${LAYER.RAW}`).get().n

/**
 * Plant a derived row. Every raw write must ALREADY have happened — D9 retires
 * the whole layer, and a fixture that plants the summary first holds nothing by
 * the time the assertion runs.
 */
const plantLayer = (db, id = 'derived-1') =>
  db
    .prepare(
      `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
       VALUES (?,'fact','repo-local','active','generated rollup','generated',?,0,0,?)`,
    )
    .run(id, DERIVED_PROVENANCE, LAYER.SCENARIO)

const insertRaw = (db, { id, status = 'active', provenance = 'human', title = 't', body = 'b' }) =>
  db
    .prepare(
      `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at,derived)
       VALUES (?,'fact','repo-local',?,?,?,?,0,0,${LAYER.RAW})`,
    )
    .run(id, status, title, body, provenance)

/**
 * ASSERTION A — "never stale". While a derived layer is alive, the sources it
 * was built from must still be byte-for-byte what they were.
 *
 * Driven by a random operation sequence over the write shapes the pipeline
 * actually performs (propose, reconcile adoption, decay, revival, forget,
 * edit, drop), because the interesting states are reached by SEQUENCES: the
 * transition that matters is often the second write to the same row.
 *
 * Snapshotting BOTH source queries, not one. `queryInjectableSet` and
 * `queryPersonaSources` share a predicate but differ in columns and order, and
 * the L2 and L3 paths read one each — a violation reachable through only one
 * of them would be invisible to a test that sampled the other.
 *
 * Read this together with B: on its own this assertion is satisfied by an
 * implementation that never keeps a layer at all.
 *
 * Run against BOTH copies of the trigger set, and this is the case that
 * carries INSERT and DELETE coverage for the live definition. C parameterizes
 * too, but every one of its 900 pairs is driven as an UPDATE, so it can only
 * ever observe `invalidate_derived_update`; B is a "does not fire too widely"
 * assertion that a never-firing trigger satisfies trivially. This walk is the
 * only D9 case that issues all three statement shapes against a live layer.
 * Measured: gutting the live DELETE or INSERT trigger to `WHEN 0` leaves the
 * whole suite green unless THIS test runs against the live set.
 */
for (const [label, target] of [
  ['the v12 migration copy (current target)', undefined],
  ['the live definition (last step is a rebuild)', 10],
]) {
  test(`D9/A: while a derived layer lives, its source set is unchanged (random sequences) — ${label}`, () => {
    const root = tempRoot()
    const db = openRaw(join(root, 'm.sqlite'))
    migrate(db, 'repo', target)
    // Asserted, not assumed — the same precondition D9/B and D9/C carry: if
    // `migrate(db,'repo',10)` ever stopped installing the live set, this case
    // would silently test the frozen copy twice.
    assert.match(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'invalidate_derived_insert'`).get().sql,
      /provenance IN/,
      'precondition: the store under test carries a source-set-scoped D9 trigger',
    )

    // Deterministic PRNG, because a failure must be reproducible and a walk drawn
    // from Math.random tells a different story every run.
    //
    // ⚠️ mulberry32, NOT the textbook LCG, and this is measured rather than
    // stylistic. The first version of this test used
    // `seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n`, whose
    // LOW BITS are famously correlated — over 6000 draws `rnd(6)` returned
    // {0:1977, 1:9, 2:1997, 3:14, 4:1997, 5:6}. Index 1 is `active` in
    // `MEMORY_STATUSES`, so the walk essentially never created an active row: at
    // the end of 1200 steps the source set held 0 rows, the layer was never once
    // invalidated, and the assertion below passed while exercising nothing. It
    // stayed green under the NEW-only and OLD-only mutants it exists to kill.
    // The liveness assertions at the bottom are what turn a repeat of that into
    // a failure instead of a green run.
    let seed = 0x5eed_1234
    const rnd = (n) => {
      seed = (seed + 0x6d_2b_79_f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n)
    }
    const sources = () =>
      JSON.stringify([
        queryInjectableSet({ db }, 200),
        queryPersonaSources({ db }, 100),
      ])

    const STATUSES = MEMORY_STATUSES
    const PROVS = PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE)
    let planted = null
    let snapshot = null
    let live = 0
    let deaths = 0
    let sawSources = 0
    let violations = []
    let ids = []

    for (let step = 0; step < 1200; step++) {
      // If a layer is alive, check it against the sources BEFORE writing again.
      if (planted !== null) {
        if (countDerived(db) === 0) {
          planted = null
          deaths++
        } else {
          live++
          if (sources() !== snapshot) {
            violations.push(`step ${step}: layer alive but its source set had changed`)
          }
        }
      }
      if (
        db
          .prepare(
            `SELECT count(*) AS n FROM memories WHERE derived = ${LAYER.RAW} AND status = 'active'
               AND provenance IN ('human','principal-explicit','parent-agent')`,
          )
          .get().n > 0
      ) {
        sawSources++
      }
      const op = rnd(6)
      if (op === 0 || ids.length === 0) {
        const id = `m${step}`
        insertRaw(db, {
          id,
          status: STATUSES[rnd(STATUSES.length)],
          provenance: PROVS[rnd(PROVS.length)],
        })
        ids.push(id)
      } else {
        const id = ids[rnd(ids.length)]
        if (op === 1) {
          db.prepare(`UPDATE memories SET status = ? WHERE id = ?`).run(
            STATUSES[rnd(STATUSES.length)],
            id,
          )
        } else if (op === 2) {
          db.prepare(`UPDATE memories SET provenance = ? WHERE id = ?`).run(
            PROVS[rnd(PROVS.length)],
            id,
          )
        } else if (op === 3) {
          // `forget`'s shape: tombstone AND blank the text, in one statement.
          db.prepare(
            `UPDATE memories SET status = 'tombstone', title = '', body = '' WHERE id = ?`,
          ).run(id)
        } else if (op === 4) {
          db.prepare(`UPDATE memories SET body = ? WHERE id = ?`).run(`edited ${step}`, id)
        } else {
          db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
          ids = ids.filter((x) => x !== id)
        }
      }
      // Rebuild the layer whenever there is none, exactly as the job would:
      // snapshot the sources, then write the derived row.
      if (planted === null && countDerived(db) === 0) {
        snapshot = sources()
        plantLayer(db, `d${step}`)
        planted = `d${step}`
      }
    }

    assert.deepEqual(violations, [], 'a live derived layer must never summarize a stale source set')

    // ⛔ LIVENESS OF THE FIXTURE, in three parts. The assertion above is a
    // statement about states the walk actually reached, so a walk that reaches
    // none of them proves nothing while reporting success — the failure this
    // test shipped with once already (see the PRNG note above), and the reason
    // each of these is checked rather than assumed.
    //
    // MARGINS, measured over 201 seeds (0 failures): `live` bottomed out at 1047
    // against a floor of 100 (10.5x), `deaths` at 55 against 10 (5.5x), and
    // `sawSources` at 164 against 100 — only 1.6x, much the tightest of the
    // three. Left as is because these are LIVENESS floors, not the property under
    // test: a seed change that scrapes one is a signal to re-measure the walk,
    // not a flake to paper over by lowering the bar.
    assert.ok(
      live > 100,
      `the layer must be observed ALIVE many times, or a never-built layer passes (was ${live})`,
    )
    assert.ok(
      sawSources > 100,
      `the SOURCE SET must be non-empty for much of the walk (was ${sawSources} steps); with an ` +
        'empty source set every write is out of scope, nothing ever invalidates, and this ' +
        'case is green against any implementation whatsoever',
    )
    assert.ok(
      deaths > 10,
      `the layer must actually be RETIRED sometimes (was ${deaths}); a walk that only ever ` +
        'adds out-of-scope rows never exercises invalidation at all',
    )
    db.close()
    cleanup(root)
  })
}

/**
 * ASSERTION B — "not too much". The narrowing IS the change, and this is the
 * only assertion that can observe it.
 *
 * A `tool-output` row is the case that motivated v12: §2.3 keeps that
 * provenance out of the injection packet, `queryInjectableSet` and
 * `queryPersonaSources` both filter it away, so it can reach neither a rollup
 * nor a portrait and cannot change what either says. On the main store
 * (5ed2b4d2) 216 of 251 active raw rows are of exactly this shape (86.1%);
 * across the nine stores it is 363 of 512 (70.9%), and under v11 every one of
 * their writes destroyed the whole derived layer.
 *
 * `store_revision` is asserted beside the row count deliberately: it rides the
 * rebuild job's idempotence key, so a bump with no invalidation still mints a
 * fresh job id and re-does the work. "The layer survived" and "nothing was
 * disturbed" are two claims.
 *
 * Run against BOTH copies of the trigger set — `migrateV12`'s frozen text,
 * which a default-target store carries, and the live
 * `createInvalidationTriggers`, which a store whose last schema step was a
 * rebuild carries. This file already learned that lesson at v11: a version of
 * this test written only against the default target leaves the live definition
 * unpinned, and the live one is what the next rebuild migration installs
 * everywhere.
 */
for (const [label, target] of [
  ['the v12 migration copy (current target)', undefined],
  ['the live definition (last step is a rebuild)', 10],
]) {
  test(`D9/B: a write outside the source set leaves the derived layer standing — ${label}`, () => {
    const root = tempRoot()
    const db = openRaw(join(root, 'm.sqlite'))
    migrate(db, 'repo', target)
    // Asserted, not assumed: if `migrate(db,'repo',10)` ever stopped installing
    // the live set, this case would silently test the frozen copy twice.
    assert.match(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'invalidate_derived_insert'`).get().sql,
      /provenance IN/,
      'precondition: the store under test carries a source-set-scoped D9 trigger',
    )

    insertRaw(db, { id: 'src-1', provenance: 'human' })
    plantLayer(db)
    assert.equal(countDerived(db), 1, 'precondition: a derived layer exists')
    const before = revisionOf(db)

    insertRaw(db, { id: 'noise-tool', provenance: 'tool-output' })
    assert.equal(
      countDerived(db),
      1,
      'inserting an active tool-output row must NOT retire the layer: §2.3 keeps that ' +
        'provenance out of the packet and both source queries filter it away, so it ' +
        'cannot change anything the layer says',
    )

    insertRaw(db, { id: 'noise-cand', status: 'candidate', provenance: 'human' })
    assert.equal(
      countDerived(db),
      1,
      'nor may a candidate row: it is invisible to every read path until reconcile adopts ' +
        'it, and that adoption is itself an UPDATE which DOES invalidate',
    )

    db.prepare(`UPDATE memories SET body = 'edited' WHERE id = 'noise-tool'`).run()
    assert.equal(
      countDerived(db),
      1,
      'nor may editing one — outside the source set on both sides of the update',
    )

    db.prepare(`DELETE FROM memories WHERE id = 'noise-tool'`).run()
    assert.equal(countDerived(db), 1, 'nor may deleting one')

    assert.equal(
      revisionOf(db),
      before,
      'and store_revision must not move: it rides the rebuild job idempotence key, so a ' +
        'bump with no invalidation still mints a fresh job id and redoes the work',
    )
    db.close()
    cleanup(root)
  })
}

/**
 * ASSERTION C — the rule over the WHOLE transition space, which is what
 * distinguishes OLD ∪ NEW from either side alone.
 *
 * Every ordered pair of the 30 non-derived (status, provenance) states — 6
 * statuses × 5 provenances, 900 pairs — driven as a real UPDATE against the
 * real trigger and asserted to invalidate exactly when
 * `inSet(OLD) OR inSet(NEW)`.
 *
 * Of the 900, 171 must fire. The single-sided implementations each miss 81 of
 * those 171 (counted directly from the rule, then confirmed by running them),
 * and the misses are not exotic:
 *   - NEW only misses every DEPARTURE — `active/human -> dormant/human` is
 *     decay, `active/human -> tombstone/human` is the user's own `forget`. The
 *     layer would go on serving a memory its owner had just deleted.
 *   - OLD only misses every ARRIVAL — `candidate/human -> active/human` is
 *     reconcile adopting a candidate, `dormant -> active` is decay reviving
 *     one. That is v5's original defect, reopened.
 *
 * Failures are COLLECTED rather than thrown at the first one: which cell
 * escapes is the diagnosis, and a bare assert inside the loop would report one
 * pair and hide the shape of the other 80.
 *
 * Run against BOTH copies of the trigger set, for the reason D9/B is, and with
 * more at stake here: C is the strongest falsifier of the three (171 counted
 * exactly, 900 pairs compared one by one), so a version of it bound to the
 * default target leaves the LIVE definition — the one the next rebuild
 * migration installs everywhere — resting on B alone. Measured before this was
 * parameterized: weakening the live UPDATE trigger to OLD only (v5's original
 * defect, reopened), the live DELETE to `WHEN 0`, and the live INSERT to
 * `WHEN 0 AND ...` each left the whole suite green. B could not catch any of
 * them — it asserts that invalidation does not fire too WIDELY, which a
 * trigger that never fires at all satisfies trivially, and its `provenance IN`
 * precondition is a TEXT match that a gutted WHEN clause still passes.
 */
for (const [label, target] of [
  ['the v12 migration copy (current target)', undefined],
  ['the live definition (last step is a rebuild)', 10],
]) {
  test(`D9/C: invalidation fires exactly when the row is in the source set before OR after — ${label}`, () => {
    const root = tempRoot()
    const db = openRaw(join(root, 'm.sqlite'))
    migrate(db, 'repo', target)
    // Asserted, not assumed — the same precondition D9/B carries, for the same
    // reason: if `migrate(db,'repo',10)` ever stopped installing the live set,
    // this case would silently test the frozen copy twice.
    assert.match(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'invalidate_derived_insert'`).get().sql,
      /provenance IN/,
      'precondition: the store under test carries a source-set-scoped D9 trigger',
    )
    const inSet = (status, provenance) =>
      status === 'active' && INJECTABLE_PROVENANCE.includes(provenance)

    const states = MEMORY_STATUSES.flatMap((status) =>
      PROVENANCES.filter((p) => p !== DERIVED_PROVENANCE).map((provenance) => ({ status, provenance })),
    )
    assert.equal(states.length, 30, 'six statuses times the five non-derived provenances')

    const wrong = []
    let firedCount = 0
    let expectedCount = 0
    for (const from of states) {
      for (const to of states) {
        db.exec(`DELETE FROM memories`)
        db.exec(`DELETE FROM meta WHERE k = 'store_revision'`)
        insertRaw(db, { id: 'x', status: from.status, provenance: from.provenance })
        plantLayer(db)
        // Sampled, never assumed: the planting INSERT must really have landed, or
        // "the layer is gone" would be true before the transition ran.
        assert.equal(countDerived(db), 1, 'the layer must exist before each transition')
        db.prepare(`UPDATE memories SET status = ?, provenance = ? WHERE id = 'x'`).run(
          to.status,
          to.provenance,
        )
        const fired = countDerived(db) === 0
        const expected = inSet(from.status, from.provenance) || inSet(to.status, to.provenance)
        if (fired) firedCount++
        if (expected) expectedCount++
        if (fired !== expected) {
          wrong.push(
            `${from.status}/${from.provenance} -> ${to.status}/${to.provenance}: ` +
              `fired=${fired} expected=${expected}`,
          )
        }
      }
    }
    assert.deepEqual(
      wrong,
      [],
      'every ordered transition must invalidate exactly when the row is in the source set on ' +
        'EITHER side; a NEW-only trigger misses every departure (decay, forget) and an ' +
        'OLD-only one misses every arrival (reconcile adoption, decay revival)',
    )
    // The COUNT, stated as a literal, so a rule that agreed with itself while
    // meaning something else cannot pass. `wrong` compares the trigger against
    // `inSet`, and both sides would move together if the expectation were
    // rewritten; 171 is the number the rule yields for these 900 pairs, computed
    // independently. A single-sided trigger fires 90 times here, not 171.
    assert.equal(expectedCount, 171, '171 of the 900 ordered pairs touch the source set')
    assert.equal(firedCount, 171, 'and the trigger fires on exactly those')
    db.close()
    cleanup(root)
  })
}

/**
 * The MIGRATION, on the route that matters: a v11 store that already exists.
 *
 * All nine live stores measured at `user_version = 11`, all nine carrying the
 * wide v11 triggers, so a change confined to TypeScript would reach none of
 * them. That is the v11-era lesson restated — "the rule is written correctly"
 * and "the rule is in force" are two claims, and only the second protects
 * anyone. The precondition below MEASURES the old behaviour first, so this
 * cannot pass against a fixture that never had the defect.
 *
 * Shaped after `v10 -> v11`, including its fixture-ordering trap: raw writes go
 * in before the derived row, or D9 has already emptied the layer the
 * assertions are about.
 */
test('v11 -> v12 scopes D9 to the derived layer source set, on a store that already exists', () => {
  const root = tempRoot()
  const db = openRaw(join(root, 'm.sqlite'))
  migrate(db, 'repo', 11)
  assert.equal(userVersion(db), 11)

  // A store as it EXISTS ON DISK at v11. `migrate(db,'repo',11)` does not
  // produce one: v11 is pure trigger DDL layered over whatever `migrateV10`'s
  // rebuild installed, so today's build already carries v12's D9 by the time
  // v11 runs. Restoring v5's wide triggers is what makes this an UPGRADE test
  // rather than a test of a store that never existed.
  const wide = `
        DELETE FROM memories WHERE derived != ${LAYER.RAW};
        INSERT INTO meta (k, v) VALUES ('store_revision', '1')
          ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT);`
  db.exec(`
    DROP TRIGGER invalidate_derived_insert;
    DROP TRIGGER invalidate_derived_update;
    DROP TRIGGER invalidate_derived_delete;
    CREATE TRIGGER invalidate_derived_insert AFTER INSERT ON memories
      WHEN NEW.derived = ${LAYER.RAW} BEGIN${wide}
    END;
    CREATE TRIGGER invalidate_derived_update AFTER UPDATE ON memories
      WHEN OLD.derived = ${LAYER.RAW} BEGIN${wide}
    END;
    CREATE TRIGGER invalidate_derived_delete AFTER DELETE ON memories
      WHEN OLD.derived = ${LAYER.RAW} BEGIN${wide}
    END;
  `)

  // Data that must survive a trigger-only migration, evidence row included —
  // the cascade a table rebuild would have endangered.
  insertRaw(db, { id: 'raw-keep', provenance: 'human', title: 'title raw-keep' })
  db.prepare(
    `INSERT INTO evidence (memory_id,kind,ref,excerpt) VALUES ('raw-keep','session','s1','the exact words')`,
  ).run()
  plantLayer(db)

  // PRECONDITION: the fixture really does over-invalidate.
  insertRaw(db, { id: 'probe-v11', provenance: 'tool-output' })
  assert.equal(
    countDerived(db),
    0,
    'precondition: at v11 an active tool-output insert retires the WHOLE derived layer',
  )

  const before = {
    memories: db.prepare(`SELECT count(*) c FROM memories`).get().c,
    evidence: db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='raw-keep'`).get().excerpt,
  }

  migrate(db, 'repo', 12)
  assert.equal(userVersion(db), 12)

  // Nothing lost, index coherent, no dangling reference.
  assert.equal(db.prepare(`SELECT count(*) c FROM memories`).get().c, before.memories)
  assert.equal(
    db.prepare(`SELECT excerpt FROM evidence WHERE memory_id='raw-keep'`).get().excerpt,
    before.evidence,
    'no evidence row may be lost to a trigger-only migration',
  )
  assert.equal(
    db
      .prepare(`SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH '"title raw-keep"'`)
      .get().c,
    1,
    'the FTS index still matches the surviving row',
  )
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)

  // The other seven triggers are untouched — this migration replaces three.
  assert.deepEqual(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
      .all()
      .map((r) => r.name),
    [
      'guard_derived_status',
      'guard_derived_status_insert',
      'guard_visibility_insert',
      'guard_visibility_update',
      'invalidate_derived_delete',
      'invalidate_derived_insert',
      'invalidate_derived_update',
      'mem_ad',
      'mem_ai',
      'mem_au',
    ],
    'all ten triggers stand: 3 FTS, 2 visibility, 2 derived guards, 3 D9',
  )

  // THE BEHAVIOUR CHANGED — the whole point of registering the migration.
  // Asserted as an OUTCOME, never as `userVersion === TARGET_USER_VERSION`,
  // which reads the same symbol on both sides and passes at any value.
  plantLayer(db, 'derived-2')
  assert.equal(countDerived(db), 1, 'a layer can be planted again after the migration')
  insertRaw(db, { id: 'probe-v12', provenance: 'tool-output' })
  assert.equal(
    countDerived(db),
    1,
    'after v12 the same insert that emptied the layer above leaves it standing — this ' +
      'migration is what carries the change to the nine live stores, all on v11',
  )
  db.prepare(`UPDATE memories SET status = 'dormant' WHERE id = 'raw-keep'`).run()
  assert.equal(
    countDerived(db),
    0,
    'while an active/human row going dormant still retires it: decay REMOVES a source, and ' +
      'a NEW-only trigger would have missed exactly this',
  )
  db.close()
  cleanup(root)
})
