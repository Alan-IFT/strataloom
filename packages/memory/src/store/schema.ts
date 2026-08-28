/**
 * DDL + atomic migration protocol (spec §2.1/§2.2).
 *
 * The version check runs INSIDE the write lock: `BEGIN IMMEDIATE` first, then
 * read `application_id`/`user_version`, then decide. Checking outside the lock
 * is the TOCTOU the spec's own fencing lesson forbids — two processes both
 * plan v1→v2 and the second replays the migration on an already-migrated
 * store (silent double-execution once a step backfills data). Verified against
 * node:sqlite in `.verify-v26` T1/T2.
 * @module @strataloom/dsh-memory/store/schema
 */
import type { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, TARGET_USER_VERSION } from '../constants.ts'
import {
  DERIVED_LAYERS,
  LAYER,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  PROVENANCES,
} from '../types.ts'
import type { StoreKind } from './store.ts'
import { immediateTx } from './tx.ts'

/** Loud, typed migration failure — a refused store must never be used. */
export class MigrationError extends Error {
  override name = 'StrataloomMigrationError'
}

/**
 * CJK codepoint range used to decide which characters need bigram treatment.
 * CJK Extension A through the unified ideographs (U+3400–U+9FFF), which covers
 * the Chinese this store actually holds.
 */
const CJK_FIRST = 0x3400
const CJK_LAST = 0x9fff

/**
 * SQL that expands the CJK inside `expr` into overlapping BIGRAMS.
 *
 * The default `unicode61` tokenizer emits ONE token per run of CJK between
 * punctuation, so a query matched only when it equalled a whole run: every
 * natural re-wording (a substring of what is stored) returned nothing.
 * Measured on the memories actually stored here — 分词器, 中文记忆, 空格分词,
 * 真相源, 工程取舍 all scored 0.
 *
 * `trigram` fixes the Chinese and BREAKS short Latin: `CI`, `Go`, `L3`, `v9`
 * become unsearchable (this corpus contains 163 distinct sub-3-character
 * tokens), and it matches across word boundaries, so `cat` starts hitting
 * `concatenate`. Bigram-indexing the CJK into its own column keeps
 * `unicode61` — and therefore every Latin token and the existing phrase,
 * escaping and `rank` semantics — exactly as it was, while making Chinese
 * reachable down to two characters (`取舍`, which trigram cannot match either).
 *
 * It is written as SQL rather than a JS helper on purpose. The four write
 * paths (propose, extract, and both rebuild kinds) all reach the index through
 * ONE trigger set, so stating the rule there gives every writer — including
 * ones not yet written — the same treatment. A JS helper would be the same
 * rule copied four times, and a registered SQL function would silently mean
 * "every connection must remember to register it or writes fail".
 */
const cjkBigrams = (expr: string): string => `
  (SELECT coalesce(group_concat(bg, ' '), '') FROM (
     WITH RECURSIVE pos(i, txt) AS (
       SELECT 1, ${expr}
       UNION ALL SELECT i + 1, txt FROM pos WHERE i < length(txt) - 1
     )
     SELECT substr(txt, i, 2) AS bg FROM pos
     WHERE unicode(substr(txt, i, 1)) BETWEEN ${CJK_FIRST} AND ${CJK_LAST}
        OR unicode(substr(txt, i + 1, 1)) BETWEEN ${CJK_FIRST} AND ${CJK_LAST}
  ))`

/**
 * Whether the index is still FTS5 external-content (pre-v9). Asked of the
 * schema rather than tracked as a version number, so migrations that run
 * BEFORE v9 keep using the contentless-table commands that were correct then
 * and the ones after use the plain table — one probe instead of a version
 * comparison duplicated at each call site.
 */
const ftsIsExternalContent = (db: DatabaseSync): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'memories_fts'`)
    .get() as { sql: string } | undefined
  return row !== undefined && row.sql.includes('content=memories')
}

/** Repopulate the index from `memories`, whichever shape it currently has. */
const refillFtsIndex = (db: DatabaseSync): void => {
  if (ftsIsExternalContent(db)) {
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`)
    return
  }
  db.exec(`
    DELETE FROM memories_fts;
    INSERT INTO memories_fts(rowid, title, body, cjk)
      SELECT rowid, title, body, ${cjkBigrams("title || ' ' || body")} FROM memories;
  `)
}

/**
 * The three triggers that keep the index in step with `memories` — the ONE
 * place the bigram rule is stated, so every write path inherits it.
 */
const recreateFtsTriggers = (db: DatabaseSync): void => {
  // Match the index that EXISTS right now. A migration older than v9 rebuilds
  // `memories` while the index is still external-content and has no `cjk`
  // column, so emitting today's trigger there would fail at CREATE time.
  if (ftsIsExternalContent(db)) {
    db.exec(`
      CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER mem_au AFTER UPDATE OF title, body ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
        INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
    `)
    return
  }
  const row = cjkBigrams("new.title || ' ' || new.body")
  db.exec(`
    CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, body, cjk)
      VALUES (new.rowid, new.title, new.body, ${row});
    END;
    CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER mem_au AFTER UPDATE OF title, body ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
      INSERT INTO memories_fts(rowid, title, body, cjk)
      VALUES (new.rowid, new.title, new.body, ${row});
    END;
  `)
}

/**
 * Every trigger attached to `memories`, in one place.
 *
 * `DROP TABLE` takes a table's triggers with it, so any migration that
 * rebuilds `memories` must put them all back. Writing them out again there
 * would be the same rule in two places — the failure mode behind D7-D9 — and
 * the copies would drift the moment one is amended. Migrations that
 * *introduce* a trigger still define it inline (a v3 store must not gain v5's
 * behaviour early); this function is the CURRENT full set, applied to a
 * freshly rebuilt table.
 */
const createMemoryTriggers = (db: DatabaseSync): void => {
  // `!= 0`, never `= 1`: `derived` is a LEVEL, so every derived layer is
  // retired together. Matching a single value would leave scenario and
  // persona blocks standing after the set they summarize had changed — the
  // exact shadowing D9 exists to prevent.
  const invalidate = `
      DELETE FROM memories WHERE derived != ${LAYER.RAW};
      INSERT INTO meta (k, v) VALUES ('store_revision', '1')
        ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT);`
  recreateFtsTriggers(db)
  db.exec(`
    -- D2, data-driven: 'private' is allowed in the global store and only there (v3).
    CREATE TRIGGER guard_visibility_insert BEFORE INSERT ON memories
      WHEN (new.visibility = 'private')
        <> ((SELECT v FROM meta WHERE k = 'store_kind') = 'global')
      BEGIN SELECT RAISE(ABORT, 'visibility does not match this store kind'); END;
    CREATE TRIGGER guard_visibility_update BEFORE UPDATE OF visibility ON memories
      WHEN (new.visibility = 'private')
        <> ((SELECT v FROM meta WHERE k = 'store_kind') = 'global')
      BEGIN SELECT RAISE(ABORT, 'visibility does not match this store kind'); END;

    -- Any derived layer is regenerated wholesale, never aged out row by row (v4).
    CREATE TRIGGER guard_derived_dormant BEFORE UPDATE OF status, derived ON memories
      WHEN new.status = 'dormant' AND new.derived != ${LAYER.RAW}
      BEGIN SELECT RAISE(ABORT, 'a derived row cannot go dormant'); END;

    -- D9: invalidation is a property of the data, not of the writer (v5).
    -- The guard matches RAW only, so a rebuild writing its own derived rows
    -- does not fence itself, whichever layer it is producing.
    CREATE TRIGGER invalidate_derived_insert AFTER INSERT ON memories
      WHEN NEW.derived = ${LAYER.RAW} BEGIN${invalidate}
    END;
    CREATE TRIGGER invalidate_derived_update AFTER UPDATE ON memories
      WHEN OLD.derived = ${LAYER.RAW} BEGIN${invalidate}
    END;
    CREATE TRIGGER invalidate_derived_delete AFTER DELETE ON memories
      WHEN OLD.derived = ${LAYER.RAW} BEGIN${invalidate}
    END;
  `)
}

/** Render a string enum as a SQL `IN (...)` list, quoted. */
const sqlEnum = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(',')

/** The columns of `memories`, current as of the newest rebuild. */
const MEMORY_COLUMNS = [
  'rowid       INTEGER PRIMARY KEY',
  'id          TEXT NOT NULL UNIQUE',
  `kind        TEXT NOT NULL CHECK (kind IN (${sqlEnum(MEMORY_KINDS)}))`,
  "visibility  TEXT NOT NULL CHECK (visibility IN ('private','repo-local','team-shareable'))",
  `status      TEXT NOT NULL CHECK (status IN (${sqlEnum(MEMORY_STATUSES)}))`,
  'title       TEXT NOT NULL',
  'body        TEXT NOT NULL',
  `provenance  TEXT NOT NULL CHECK (provenance IN (${sqlEnum(PROVENANCES)}))`,
  'created_at  INTEGER NOT NULL',
  'updated_at  INTEGER NOT NULL',
  'superseded_by TEXT REFERENCES memories(id)',
  // As of v6, `derived` is still the boolean rollup flag; v7 overrides this
  // definition to widen it into a layer. A migration must reproduce the schema
  // OF ITS OWN VERSION, so the baseline here is the oldest rebuild's, and each
  // later rebuild passes only what it changes.
  `derived     INTEGER NOT NULL DEFAULT ${LAYER.RAW} CHECK (derived IN (${LAYER.RAW},${LAYER.SUMMARY}))`,
  'human_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (human_confirmed IN (0,1))',
] as const

/**
 * Rebuild `memories` in place, replacing the column definitions named in
 * `overrides`. SQLite cannot widen a CHECK, so every enum extension is a
 * rebuild; doing it here once means the hazards are handled once:
 *
 * - `evidence.memory_id` is `ON DELETE CASCADE`, so dropping the old table
 *   with foreign keys enforced **deletes every evidence row** — the
 *   provenance D3 guarantees. Measured, not assumed. `migrate()` therefore
 *   runs with enforcement off and re-checks before committing.
 * - The triggers belong to the table and go down with it; they come back from
 *   `createMemoryTriggers`, the single definition.
 * - The FTS index survives as a table but its rowids now reference dropped
 *   content, so it is rebuilt rather than trusted.
 *
 * A migration passes only the column it is changing. Writing out the whole
 * table per migration would fork the schema into as many copies as there are
 * rebuilds, and the copies would drift.
 * @param db - the connection being migrated.
 * @param overrides - replacement column definitions, matched by column name.
 */
const rebuildMemories = (db: DatabaseSync, ...overrides: readonly string[]): void => {
  const nameOf = (definition: string): string => definition.trim().split(/\s+/)[0] ?? ''
  const replaced = new Map(overrides.map((definition) => [nameOf(definition), definition]))
  const columns = MEMORY_COLUMNS.map(
    (definition) => replaced.get(nameOf(definition)) ?? definition,
  )
  const names = MEMORY_COLUMNS.map(nameOf).join(', ')
  db.exec(`
    CREATE TABLE memories_rebuilt (${columns.join(',\n      ')});
    INSERT INTO memories_rebuilt (${names}) SELECT ${names} FROM memories;
    DROP TABLE memories;
    ALTER TABLE memories_rebuilt RENAME TO memories;
    CREATE INDEX memories_decay ON memories(status, updated_at);
  `)
  refillFtsIndex(db)
  createMemoryTriggers(db)
}

const readPragma = (db: DatabaseSync, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row?.[name]
  if (typeof value !== 'number') throw new MigrationError(`PRAGMA ${name} unreadable`)
  return value
}

/**
 * user_version = 1 (P0): memories / evidence / meta / FTS + sync triggers +
 * repo guard. No `superseded_by` (its writer, reconcile, arrives with v2) and
 * no `explicit_save`/`origin` columns (folded into provenance and evidence —
 * spec §2.2 v2.6).
 */
const migrateV1 = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE memories (
      rowid       INTEGER PRIMARY KEY,
      id          TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL CHECK (kind IN ('fact','preference','procedure')),
      visibility  TEXT NOT NULL CHECK (visibility IN ('private','repo-local','team-shareable')),
      status      TEXT NOT NULL CHECK (status IN
                    ('candidate','active','superseded','dormant','archived','tombstone')),
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      provenance  TEXT NOT NULL CHECK (provenance IN
                    ('human','principal-explicit','parent-agent','subagent','tool-output','derived')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE evidence (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL CHECK (kind IN ('session','commit','file','url')),
      ref       TEXT NOT NULL,
      excerpt   TEXT,
      PRIMARY KEY (memory_id, kind, ref)
    );
    CREATE INDEX evidence_by_ref ON evidence(kind, ref);

    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);

    -- The tokenizer OF THIS ERA, kept verbatim. A migration reproduces the
    -- store as it was; writing today's choice here would make the upgrade
    -- untestable, because the "before" would already be the "after". v9
    -- re-tokenizes.
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      title, body, content=memories, content_rowid=rowid);
    CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
    END;
    CREATE TRIGGER mem_au AFTER UPDATE OF title, body ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    -- Repo-store guard: repo data is never private (D2). The mirror guard
    -- (global store rejects non-private) ships with the migration that
    -- enables the global store (P2) — its writer does not exist yet.
    CREATE TRIGGER guard_repo_insert BEFORE INSERT ON memories
      WHEN new.visibility = 'private'
      BEGIN SELECT RAISE(ABORT, 'repo store rejects private visibility'); END;
    CREATE TRIGGER guard_repo_update BEFORE UPDATE OF visibility ON memories
      WHEN new.visibility = 'private'
      BEGIN SELECT RAISE(ABORT, 'repo store rejects private visibility'); END;
  `)
}

/**
 * user_version = 2 (P1): jobs / usage / memories.superseded_by. jobs.kind is a
 * feature registry, not domain state space — only this phase's writers are
 * carved (spec §2.2); rebuild/decay/compact extend the CHECK in their own
 * migrations.
 */
const migrateV2 = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE jobs (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('extract','reconcile')),
      payload      TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','running','done','failed')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      run_after    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      lease_token  TEXT,
      lease_until  INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX jobs_claimable ON jobs(state, run_after);

    CREATE TABLE usage (
      memory_id   TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      retrieved   INTEGER NOT NULL DEFAULT 0,
      last_hit_at INTEGER
    );

    ALTER TABLE memories ADD COLUMN superseded_by TEXT REFERENCES memories(id);
  `)
}

/**
 * user_version = 3: the L0 conversation substrate and the global store.
 *
 * `conversations` makes provenance self-contained: the turn transcript is
 * captured into OUR store at the turn boundary, so extraction and audit no
 * longer depend on the platform session log surviving. It is deliberately
 * NOT a second search index — the distilled layer (`memories`) is what
 * `memory_recall` searches; L0 answers "what were the exact words behind
 * this memory", reached by (session, turn) from an evidence row.
 *
 * The guard becomes data-driven: one store kind recorded in `meta` decides
 * the visibility rule, so a single schema serves both stores and the
 * bidirectional invariant (private ⟺ global) is stated exactly once.
 */
const migrateV3 = (db: DatabaseSync, kind: StoreKind): void => {
  db.exec(`
    CREATE TABLE conversations (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      turn       INTEGER NOT NULL,
      label      TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN
                   ('human','principal-explicit','parent-agent','subagent','tool-output','derived')),
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX conversations_by_turn ON conversations(session_id, turn);

    -- Stamp the kind atomically with the guard that reads it. A store
    -- migrated from v2 predates the global store, so it can only be a repo
    -- store; DO NOTHING keeps that fact if it is somehow already present.
    INSERT INTO meta (k, v) VALUES ('store_kind', '${kind}')
      ON CONFLICT(k) DO NOTHING;

    DROP TRIGGER guard_repo_insert;
    DROP TRIGGER guard_repo_update;

    -- D2 as one expression: 'private' is allowed in the global store and
    -- ONLY there. The inequality is the XOR — either both hold or neither.
    CREATE TRIGGER guard_visibility_insert BEFORE INSERT ON memories
      WHEN (new.visibility = 'private')
        <> ((SELECT v FROM meta WHERE k = 'store_kind') = 'global')
      BEGIN SELECT RAISE(ABORT, 'visibility does not match this store kind'); END;
    CREATE TRIGGER guard_visibility_update BEFORE UPDATE OF visibility ON memories
      WHEN (new.visibility = 'private')
        <> ((SELECT v FROM meta WHERE k = 'store_kind') = 'global')
      BEGIN SELECT RAISE(ABORT, 'visibility does not match this store kind'); END;
  `)
}

/** Every migration takes the store kind; most ignore it. */
/**
 * user_version = 4: decay (dormant) and the derived summary layer.
 *
 * `derived` marks LLM-rebuilt rollups (L2/L3). The cross constraint lands
 * here rather than in v1 because BOTH its writers now exist: decay writes
 * `dormant`, rebuild writes `derived`, and a derived rollup must never go
 * dormant — it is regenerated wholesale, not aged out row by row.
 */
const migrateV4 = (db: DatabaseSync): void => {
  db.exec(`
    ALTER TABLE memories ADD COLUMN derived INTEGER NOT NULL DEFAULT 0
      CHECK (derived IN (0,1));
    ALTER TABLE memories ADD COLUMN human_confirmed INTEGER NOT NULL DEFAULT 0
      CHECK (human_confirmed IN (0,1));

    -- Both sides of this constraint have writers as of this version (§2.2).
    CREATE TRIGGER guard_derived_dormant BEFORE UPDATE OF status, derived ON memories
      WHEN new.status = 'dormant' AND new.derived = 1
      BEGIN SELECT RAISE(ABORT, 'a derived rollup cannot go dormant'); END;

    CREATE INDEX memories_decay ON memories(status, updated_at);
  `)
  // jobs.kind is a feature registry: extend it as writers arrive (§2.2).
  db.exec(`
    CREATE TABLE jobs_v4 (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('extract','reconcile','decay','rebuild')),
      payload      TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','running','done','failed')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      run_after    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      lease_token  TEXT,
      lease_until  INTEGER,
      completed_at INTEGER
    );
    INSERT INTO jobs_v4 SELECT * FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v4 RENAME TO jobs;
    CREATE INDEX jobs_claimable ON jobs(state, run_after);
  `)
}

/**
 * user_version = 5: derived-layer invalidation becomes a property of the DATA,
 * not of the code path that wrote it.
 *
 * v4 invalidated the rollup from `commitL1Mutation` — the tool write entry.
 * But the pipeline commits through `commitClaimedJob`, so `reconcile`
 * (candidate ⇒ active) and `decay` (active ⇒ dormant) changed the authoritative
 * set WITHOUT retiring the summary built from the old one. The stale rollup
 * then *replaces* the real rows on the read path, so a freshly learned fact
 * ("this repo now uses pnpm") stayed invisible behind an outdated summary
 * ("repo uses npm"). It could not self-heal either: the rebuild job's
 * idempotence key is the revision, so with the revision frozen the retry was
 * absorbed as a duplicate of the job that already ran.
 *
 * "Two write entries, one of which remembers" is the same shape of bug as any
 * rule written twice. Stating it once in SQL removes the class: ANY change to a
 * non-derived row invalidates, whichever code path made it, including paths not
 * written yet. `WHEN OLD/NEW.derived = 0` is what keeps rebuild's own
 * delete-then-insert from fencing itself.
 */
const migrateV5 = (db: DatabaseSync): void => {
  const invalidate = `
      DELETE FROM memories WHERE derived = 1;
      INSERT INTO meta (k, v) VALUES ('store_revision', '1')
        ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT);`
  db.exec(`
    CREATE TRIGGER invalidate_derived_insert AFTER INSERT ON memories
      WHEN NEW.derived = 0 BEGIN${invalidate}
    END;
    CREATE TRIGGER invalidate_derived_update AFTER UPDATE ON memories
      WHEN OLD.derived = 0 BEGIN${invalidate}
    END;
    CREATE TRIGGER invalidate_derived_delete AFTER DELETE ON memories
      WHEN OLD.derived = 0 BEGIN${invalidate}
    END;
  `)
}

/**
 * user_version = 6: `coding` joins the kind enum (4×4 phase 1, D10).
 *
 * Widening a CHECK means rebuilding the table — the cost the spec says the
 * migration enabling a feature should pay (§2.2). Two hazards make the naive
 * rebuild wrong, and both are load-bearing:
 *
 * 1. `evidence.memory_id` is `REFERENCES memories(id) ON DELETE CASCADE`, so
 *    `DROP TABLE memories` with foreign keys ON **deletes every evidence row**
 *    — erasing the provenance D3 exists to guarantee. Verified: the row count
 *    goes to zero. The official 12-step procedure disables `foreign_keys` for
 *    the rebuild, which is why the caller does so around the migration (that
 *    pragma is a no-op inside a transaction).
 * 2. Nine triggers and the FTS index hang off this table. `DROP TABLE` takes
 *    the triggers with it, so they are recreated here — from ONE definition
 *    shared with the migrations that introduced them, never a second copy.
 *
 * The kind list itself comes from `MEMORY_KINDS`, so the enum the code accepts
 * and the enum the database enforces cannot disagree.
 */
const migrateV6 = (db: DatabaseSync): void => {
  rebuildMemories(db, `kind TEXT NOT NULL CHECK (kind IN (${sqlEnum(MEMORY_KINDS)}))`)
}

/**
 * user_version = 7: `derived` widens from a boolean to a LAYER (4×4 phase 2).
 *
 * L2 scenarios and the L3 persona need no table, no column, and no
 * invalidation protocol of their own — they are rows of the layer they belong
 * to. Only the CHECK has to admit the new values, which is again a rebuild.
 *
 * Nothing else in this migration: the D9 triggers already read
 * `derived = RAW`, so they are recreated (by the rebuild) with semantics that
 * cover every layer, including layers not yet written. That is the whole
 * dividend of having stated invalidation over the data in v5.
 */
const migrateV7 = (db: DatabaseSync): void => {
  rebuildMemories(
    db,
    `derived INTEGER NOT NULL DEFAULT ${LAYER.RAW}
       CHECK (derived IN (${[LAYER.RAW, ...DERIVED_LAYERS].join(',')}))`,
  )
}

/**
 * user_version = 8: a failed job records WHY it failed.
 *
 * A dead letter used to be unattributable after the fact: the reason lived
 * only in a log line, and logs rotate. Live proof — the global store's L3
 * portrait job burned five attempts and its cause was already unrecoverable
 * when someone came to ask. The evidence for a decision must outlive the
 * logs, which is the same rule §9 already follows for metrics (computed from
 * stored rows, never accumulated in memory).
 *
 * One nullable column on the row that already exists, written at the single
 * failure exit. Not a new table (a job has at most one last cause), and not a
 * per-attempt history (the question is "why is this stuck now", and keeping
 * every attempt would grow without bound for a permanently broken route).
 */
const migrateV8 = (db: DatabaseSync): void => {
  db.exec(`ALTER TABLE jobs ADD COLUMN last_error TEXT`)
}

/**
 * user_version = 9: the index gains a CJK bigram column, so Chinese is
 * reachable by re-wording instead of only verbatim.
 *
 * The store held Chinese memories `memory_recall` could not find unless the
 * query repeated a whole punctuation-delimited run of the stored wording — a
 * failure the project had already written down AS a memory, which is what made
 * it measurable.
 *
 * The index stops being external-content: `cjk` is derived text with no column
 * behind it in `memories`. Its rows are still fully derived from `memories`,
 * so the table is rebuilt from there and the sync triggers (recreated by
 * `createMemoryTriggers`) keep it current from the single place they live.
 */
const migrateV9 = (db: DatabaseSync): void => {
  db.exec(`
    DROP TABLE memories_fts;
    CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, cjk);
    DROP TRIGGER mem_ai;
    DROP TRIGGER mem_ad;
    DROP TRIGGER mem_au;
  `)
  refillFtsIndex(db)
  recreateFtsTriggers(db)
}

const MIGRATIONS: readonly ((db: DatabaseSync, kind: StoreKind) => void)[] = [
  migrateV1,
  migrateV2,
  migrateV3,
  migrateV4,
  migrateV5,
  migrateV6,
  migrateV7,
  migrateV8,
  migrateV9,
]

/**
 * Run the atomic migration protocol on an opened connection. Assumes
 * per-connection pragmas (WAL, busy_timeout) are already set — WAL cannot be
 * switched inside a transaction. `target` exists as a test seam for
 * stepwise-upgrade coverage; production callers use the default.
 *
 * Foreign keys are disabled for the duration and restored afterwards. A
 * migration that rebuilds a table (v6 does) must drop the old one, and with
 * enforcement ON that cascades through `evidence.memory_id` and deletes every
 * provenance row — measured, not theorised. `PRAGMA foreign_keys` is a no-op
 * inside a transaction, so the toggle has to live out here, and
 * `foreign_key_check` below re-validates before anything is committed.
 * Deferred enforcement would not do: the cascade is a DELETE, not a
 * constraint violation, so there would be nothing left to check.
 *
 * Temp storage is pinned to MEMORY for the same window. Dropping a table —
 * which every rebuild migration does — makes SQLite reach for a temporary
 * FILE, whose location comes from the environment (TMPDIR, and on some
 * sandboxes nowhere writable at all). Measured: v9 failed with "unable to
 * open database file" purely because that spill had nowhere to go. A
 * migration must depend on the store it was handed, not on the ambient
 * filesystem, and these transactions are small enough to hold in memory.
 */
export const migrate = (
  db: DatabaseSync,
  kind: StoreKind = 'repo',
  target: number = TARGET_USER_VERSION,
): void => {
  db.exec('PRAGMA foreign_keys = OFF')
  const temp = readPragma(db, 'temp_store')
  db.exec('PRAGMA temp_store = MEMORY')
  try {
    migrateWithForeignKeysOff(db, kind, target)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`PRAGMA temp_store = ${temp}`)
  }
}

const migrateWithForeignKeysOff = (
  db: DatabaseSync,
  kind: StoreKind,
  target: number,
): void => {
  immediateTx(db, () => {
    // Inside the lock: check-then-act is now race-free.
    const appId = readPragma(db, 'application_id')
    const version = readPragma(db, 'user_version')
    if (appId !== 0 && appId !== APPLICATION_ID) {
      throw new MigrationError(
        `not a StrataLoom store (application_id=0x${appId.toString(16)})`,
      )
    }
    if (appId === 0 && version !== 0) {
      throw new MigrationError(`unbranded store with user_version=${version}`)
    }
    if (version > target) {
      throw new MigrationError(
        `store version ${version} is newer than supported ${target} (downgrade refused)`,
      )
    }
    if (version === target) return // another process finished first — empty commit
    for (let v = version; v < target; v++) {
      const step = MIGRATIONS[v]
      if (step === undefined) throw new MigrationError(`no migration from version ${v}`)
      step(db, kind)
    }
    // Post-migration verification, before the version stamp makes this store
    // readable. Foreign keys were unenforced above, so prove nothing was left
    // dangling; then prove the FTS external-content index is coherent.
    const dangling = db.prepare('PRAGMA foreign_key_check').all()
    if (dangling.length > 0) {
      throw new MigrationError(
        `migration left ${dangling.length} dangling foreign key row(s); rolled back`,
      )
    }
    // 'integrity-check' verifies an external-content index against its source.
    // Once the index owns its rows (v9), the equivalent proof is that every
    // memory has an index row — checked directly rather than skipped.
    if (ftsIsExternalContent(db)) {
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')`)
    } else {
      const missing = db
        .prepare(
          `SELECT count(*) AS n FROM memories m
           WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.rowid = m.rowid)`,
        )
        .get() as { n: number }
      if (missing.n > 0) {
        throw new MigrationError(
          `migration left ${missing.n} memor(ies) unindexed; rolled back`,
        )
      }
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${target}`)
  })
}
