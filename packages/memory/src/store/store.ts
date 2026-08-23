/**
 * Store registry: per-repo SQLite stores under `~/.dsh/strataloom/repos/`,
 * discovered by directory scan, opened on activation and on first touch,
 * always-open until dispose (spec §2.1 — no refcounting: it would starve
 * leftover jobs).
 * @module @strataloom/dsh-memory/store/store
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BUSY_TIMEOUT_MS, SLOW_STATEMENT_MS } from '../constants.ts'
import { migrate, MigrationError } from './schema.ts'
import { immediateTx, withBusyRetry } from './tx.ts'

/** Minimal structured-log seam (fail open, NOT fail silent — spec §0). */
export interface StoreLogger {
  warn(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
}

/**
 * Which scope a store carries (D2). The kind is stamped in the store's own
 * `meta` and enforced by its visibility trigger, so scope is a property of
 * the physical file — not of any field a caller could set.
 */
export type StoreKind = 'repo' | 'global'

/** The single global (private) store's registry key. */
export const GLOBAL_STORE_KEY = '@global'

/** One open store. */
export interface OpenStore {
  /** Registry key: a repo hash, or {@link GLOBAL_STORE_KEY}. */
  readonly repoKey: string
  readonly kind: StoreKind
  readonly db: DatabaseSync
  /** Run a write transaction (BEGIN IMMEDIATE) against this store. */
  tx<T>(body: () => T): T
  /** Timed prepared-statement read helper with slow-statement warning. */
  timed<T>(label: string, body: () => T): T
}

/** Registry owning every open store connection. */
export class StoreRegistry {
  private readonly stores = new Map<string, OpenStore>()
  private disposed = false

  constructor(
    private readonly rootDir: string,
    private readonly log: StoreLogger,
  ) {}

  /**
   * Activation-time discovery (spec §2.1): the global store plus every
   * `repos/<key>/memory.sqlite` found by directory scan.
   */
  openAllKnown(): void {
    // The global store is opened eagerly: personal memories must be
    // injectable from the first assembly — including in sessions with no
    // repo at all — and the injection path deliberately never opens stores.
    try {
      this.openGlobal()
    } catch (error) {
      this.log.warn('strataloom: refusing global store:', error)
    }
    const reposDir = join(this.rootDir, 'repos')
    if (!existsSync(reposDir)) return
    for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dbPath = join(reposDir, entry.name, 'memory.sqlite')
      if (!existsSync(dbPath)) continue
      try {
        this.open(entry.name)
      } catch (error) {
        // One corrupt store must not take down the plugin: fail open per
        // store, loudly (spec §0).
        this.log.warn(`strataloom: refusing store ${entry.name}:`, error)
      }
    }
  }

  /** Get an already-open store without opening (injection hot path). */
  get(repoKey: string): OpenStore | undefined {
    return this.stores.get(repoKey)
  }

  /** All open stores (job runner polls these). */
  all(): readonly OpenStore[] {
    return [...this.stores.values()]
  }

  /** Open (and migrate) the single global store, creating it on first touch. */
  openGlobal(): OpenStore {
    return this.open(GLOBAL_STORE_KEY)
  }

  /**
   * Open (and migrate) a store, creating the file on first touch. The
   * registry key decides both the path and the kind: {@link GLOBAL_STORE_KEY}
   * is the one private store, everything else is a repo hash. One code path
   * serves both — they differ by a directory and a `meta` row.
   */
  open(repoKey: string, sourceNote?: string): OpenStore {
    if (this.disposed) throw new Error('strataloom store registry is disposed')
    const existing = this.stores.get(repoKey)
    if (existing !== undefined) return existing
    const kind: StoreKind = repoKey === GLOBAL_STORE_KEY ? 'global' : 'repo'
    const dir = kind === 'global' ? this.rootDir : join(this.rootDir, 'repos', repoKey)
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, kind === 'global' ? 'global.sqlite' : 'memory.sqlite'))
    try {
      // busy_timeout FIRST: switching journal mode needs a brief exclusive
      // lock, so a store being opened while another process writes fails
      // instantly unless this connection already knows to wait. Two harness
      // processes starting at once is the ordinary case, not a rare race.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      // Switching a fresh database into WAL takes a brief exclusive lock
      // that `busy_timeout` does NOT wait for, so two processes creating the
      // same store at once can collide. Once the file is in WAL this is a
      // no-op needing no lock, which is why only creation races.
      withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'))
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA synchronous = NORMAL')
      // The kind is stamped inside the migration transaction (it must be
      // atomic with the guard that reads it), then verified: a store already
      // branded with the other kind is refused rather than reinterpreted.
      migrate(db, kind)
      const declared = db
        .prepare(`SELECT v FROM meta WHERE k = 'store_kind'`)
        .get() as { v: string } | undefined
      if (declared?.v !== kind) {
        throw new MigrationError(
          `store ${repoKey} is a '${declared?.v ?? 'unknown'}' store, refusing to open it as '${kind}'`,
        )
      }
      if (sourceNote !== undefined) {
        immediateTx(db, () => {
          db.prepare(
            `INSERT INTO meta (k, v) VALUES ('repo_source', ?)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          ).run(sourceNote)
        })
      }
    } catch (error) {
      db.close()
      throw error
    }
    const log = this.log
    const store: OpenStore = {
      repoKey,
      kind,
      db,
      tx: (body) => immediateTx(db, body),
      timed: (label, body) => {
        const start = performance.now()
        try {
          return body()
        } finally {
          const elapsed = performance.now() - start
          if (elapsed > SLOW_STATEMENT_MS) {
            log.warn(`strataloom: slow statement ${label}: ${elapsed.toFixed(1)}ms`)
          }
        }
      },
    }
    this.stores.set(repoKey, store)
    return store
  }

  /** Close every connection. In-flight transactions roll back with the connection (spec §8). */
  dispose(): void {
    this.disposed = true
    for (const [key, store] of this.stores) {
      try {
        store.db.close()
      } catch (error) {
        this.log.warn(`strataloom: closing store ${key} failed:`, error)
      }
    }
    this.stores.clear()
  }
}
