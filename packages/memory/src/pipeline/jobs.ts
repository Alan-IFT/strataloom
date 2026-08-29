/**
 * Job lifecycle (spec §5.2, D6): idempotent enqueue (the idempotence key IS
 * the primary key, so a repeat is absorbed — except that a dead-lettered row
 * is revived by a fresh trigger, see `enqueueJob`), claim-increments-attempts
 * (poison-job line), and `commitClaimedJob` — the ONLY success commit path,
 * with the fencing CAS BEFORE any business write.
 * @module @strataloom/dsh-memory/pipeline/jobs
 */
import { createHash, randomUUID } from 'node:crypto'
import type { OpenStore } from '../store/store.ts'
import {
  DONE_RETENTION_MS,
  FAILED_RETENTION_MS,
  JOB_ERROR_MAX_CHARS,
  MAX_CLAIMS,
  RETRY_BACKOFF_MS,
} from '../constants.ts'

/** Job kinds carved in schema v2 (feature registry — spec §2.2). */
export type JobKind = 'extract' | 'reconcile' | 'decay' | 'rebuild'

/** One claimed job row. */
export interface ClaimedJob {
  readonly id: string
  readonly kind: JobKind
  readonly payload: string
  readonly attempts: number
  readonly leaseToken: string
}

/** Fencing violation: a late worker lost its lease; zero business writes happened. */
export class FencingError extends Error {
  override name = 'StrataloomFencingError'
}

/** Deterministic job id from the idempotence key parts (spec §5.2). */
export const jobId = (kind: JobKind, ...parts: readonly (string | number)[]): string =>
  createHash('sha256').update([kind, ...parts].join('\u0000')).digest('hex').slice(0, 32)

/**
 * Idempotent enqueue. Re-triggering the same key is absorbed by the primary
 * key — no check-then-insert race (spec §2.2). Runs in its own immediate
 * transaction unless the caller is already inside one (pass `inTx`).
 *
 * With ONE exception, which the conflict clause states rather than any caller:
 * a `failed` row is REVIVED by a fresh trigger. Dead-lettering answers "stop
 * retrying this attempt", not "never do this work again" — but with a
 * deterministic id the two collapse, and absorbing the retrigger turns a dead
 * letter into a permanent veto for as long as the row survives (30 days, or
 * forever if cleanup never runs). Observed live: the global store's L3
 * portrait job dead-lettered at one snapshot and stayed unbuilt across five
 * days of maintenance passes that each re-enqueued it into `DO NOTHING`.
 *
 * `pending`/`running` are still absorbed (the work is already scheduled) and
 * so is `done` (it finished for this snapshot). Only the terminal-but-unfinished
 * state reopens, which keeps the recovery rule in the one place every job kind
 * already goes through — no per-kind retry counter, no new column, no
 * "remember to revive" branch in a handler. The trigger's own cadence
 * (the maintenance interval) is the retry throttle, so no new threshold.
 */
export const enqueueJob = (
  store: OpenStore,
  kind: JobKind,
  id: string,
  payload: unknown,
  runAfter: number,
  inTx = false,
): void => {
  const insert = (): void => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload      = excluded.payload,
           state        = 'pending',
           attempts     = 0,
           run_after    = excluded.run_after,
           created_at   = excluded.created_at,
           lease_token  = NULL,
           lease_until  = NULL,
           completed_at = NULL,
           last_error   = NULL
         WHERE jobs.state = 'failed'`,
      )
      .run(id, kind, JSON.stringify(payload), runAfter, Date.now())
  }
  if (inTx) insert()
  else store.tx(insert)
}

/**
 * Peek the next claimable job WITHOUT claiming (the runner checks the
 * principal agent's status before claiming — spec §5.2 认领前查; peeking
 * avoids inflating `attempts` on a voluntary skip).
 */
export const peekClaimable = (
  store: OpenStore,
  now: number,
): { id: string; payload: string } | undefined =>
  store.db
    .prepare(
      `SELECT id, payload FROM jobs
       WHERE (state = 'pending' OR (state = 'running' AND lease_until < ?))
         AND run_after <= ?
       ORDER BY run_after, created_at LIMIT 1`,
    )
    .get(now, now) as { id: string; payload: string } | undefined

/**
 * Claim the next runnable job (spec §5.2). Attempts increment ON CLAIM —
 * a worker that crashes mid-run still consumed one attempt, which is the
 * poison-job defense.
 */
export const claimNextJob = (
  store: OpenStore,
  now: number,
  leaseUntil: number,
): ClaimedJob | undefined => {
  const leaseToken = randomUUID()
  return store.tx(() => {
    const row = store.db
      .prepare(
        `UPDATE jobs
         SET state = 'running', lease_token = ?, lease_until = ?, attempts = attempts + 1
         WHERE id = (SELECT id FROM jobs
                     WHERE (state = 'pending' OR (state = 'running' AND lease_until < ?))
                       AND run_after <= ?
                     ORDER BY run_after, created_at LIMIT 1)
         RETURNING id, kind, payload, attempts`,
      )
      .get(leaseToken, leaseUntil, now, now) as
      | { id: string; kind: JobKind; payload: string; attempts: number }
      | undefined
    if (row === undefined) return undefined
    return { ...row, leaseToken }
  })
}

/** Whether a freshly claimed job crossed the dead-letter line (spec §5.2). */
export const isPoisoned = (job: ClaimedJob): boolean => job.attempts > MAX_CLAIMS

/**
 * commitClaimedJob (spec §5.2, D6): the only success path. Fencing CAS runs
 * FIRST inside the transaction — `changes()==1` or the whole transaction
 * rolls back and the late worker performed zero business writes. `mutate`
 * then applies business writes (memories/evidence/meta + derived-job
 * enqueues) in the same transaction.
 */
export const commitClaimedJob = (
  store: OpenStore,
  jobId_: string,
  leaseToken: string,
  mutate: () => void,
): void => {
  store.tx(() => {
    const result = store.db
      .prepare(
        `UPDATE jobs SET state = 'done', completed_at = ?
         WHERE id = ? AND state = 'running' AND lease_token = ?`,
      )
      .run(Date.now(), jobId_, leaseToken)
    if (Number(result.changes) !== 1) {
      throw new FencingError(`job ${jobId_}: lease lost before commit`)
    }
    mutate()
  })
}

/**
 * Failure/retry exit — same lease-conditional CAS shape (spec §5.2). A lost
 * lease makes this a no-op (the successor owns the job now). `dead` forces
 * the dead-letter state regardless of attempts.
 *
 * `cause` is stored on the row because this is the ONLY exit a failing job
 * takes, so recording it here covers every job kind and every future one.
 * Logs answered this before and logs rotate: a dead letter found days later
 * had no recoverable reason, which is exactly when the reason is needed.
 * The text is truncated and carries no prompt or reply — a cause, not a
 * transcript, so no memory content leaks into an operator surface.
 */
export const failClaimedJob = (
  store: OpenStore,
  jobId_: string,
  leaseToken: string,
  attempts: number,
  dead: boolean,
  cause?: unknown,
): void => {
  const reason = describeCause(cause)
  store.tx(() => {
    if (dead || attempts > MAX_CLAIMS) {
      store.db
        .prepare(
          `UPDATE jobs SET state = 'failed', completed_at = ?, lease_token = NULL,
             lease_until = NULL, last_error = COALESCE(?, last_error)
           WHERE id = ? AND state = 'running' AND lease_token = ?`,
        )
        .run(Date.now(), reason, jobId_, leaseToken)
    } else {
      store.db
        .prepare(
          `UPDATE jobs SET state = 'pending', lease_token = NULL, lease_until = NULL,
             run_after = ?, last_error = COALESCE(?, last_error)
           WHERE id = ? AND state = 'running' AND lease_token = ?`,
        )
        .run(Date.now() + RETRY_BACKOFF_MS * attempts, reason, jobId_, leaseToken)
    }
  })
}

/** One line naming the failure: `ErrorName: message`, bounded. */
const describeCause = (cause: unknown): string | null => {
  if (cause === undefined || cause === null) return null
  const text =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  return text.replace(/\s+/g, ' ').trim().slice(0, JOB_ERROR_MAX_CHARS) || null
}

/**
 * Low-frequency cleanup (spec §5.2: done>7d, failed>30d; P1 tick-driven), plus
 * one age-independent delete.
 *
 * A failed `rebuild` queued for a superseded revision is unreachable: its id is
 * `jobId('rebuild', repoKey, expectedRevision)`, so a later snapshot computes a
 * DIFFERENT id and this row is never revived (see `enqueueJob`) — and the work
 * itself is not lost, because the successor rebuild redoes the whole portrait.
 * That is not a new rule: it is `runRebuildJob`'s own fencing check
 * (`readRevision(store) !== payload.expectedRevision`) applied to the row's
 * lifetime instead of to a claim. One rule, defined once, effective at two
 * moments. Keeping the row for 30 days only invites a reader to chase work the
 * store already left behind.
 *
 * Four clauses do four different jobs, and none covers for another:
 *
 * - `kind = 'rebuild'` is what spares every other kind. Only rebuild's id
 *   carries the revision, so only rebuild's reachability is readable from the
 *   payload; extract/reconcile/decay are judged by age alone. Dropping this
 *   filter and leaning on the comparison would delete every fresh extract dead
 *   letter, whose payload also yields NULL here.
 * - `json_valid(payload)` keeps ONE unreadable row from cancelling the whole
 *   maintenance pass. `json_extract` throws on non-JSON text, and all three
 *   deletes share one transaction inside `maintain`, which has no inner catch —
 *   so a single malformed payload rolls back the age-based cleanups too, then
 *   `pruneConversations`, the decay enqueue and the rebuild trigger never run,
 *   and the store re-crashes on that same row every maintenance interval. No
 *   current writer can produce such a row (every enqueue goes through
 *   `JSON.stringify`), but a hand-edited or externally written one can, and a
 *   statement on the maintenance path must not be able to disable maintenance.
 *   A row whose payload cannot be read simply cannot prove anything about
 *   reachability, so it falls through to the 30-day age line like any other.
 * - `IS NOT` rather than `!=`, and `COALESCE(..., 0)` on the right, resolve the
 *   TWO NULLs in this comparison. They are different states and must not get
 *   the same answer:
 *
 *   LEFT NULL — the rebuild row carries no `expectedRevision`. Not a shape this
 *   code writes (`RebuildPayload` always sets it), but one a legacy or
 *   hand-edited row can have. Such a row must GO: it can never be matched to a
 *   snapshot, so it can never be revived, and it would never age out of
 *   relevance either. `NULL != 11` is NULL, which WHERE reads as false, so `!=`
 *   would keep it forever; `NULL IS NOT 11` is 1, which treats a rebuild that
 *   cannot prove it belongs to the current snapshot as not belonging — the same
 *   default `runRebuildJob` applies when it fences.
 *
 *   RIGHT NULL — the store has never written `store_revision` at all. Such a
 *   row must STAY. That meta row is written only by the memories invalidate
 *   trigger, so every store without a raw memory yet lacks it, which makes this
 *   the NORMAL state of a new store rather than an edge case. `readRevision`
 *   reads the missing row as 0, so an `expectedRevision: 0` rebuild there is
 *   fully reachable — the next trigger computes exactly its id and revives it.
 *   Without the COALESCE the subquery yields NULL, `IS NOT` is true against
 *   every left value, and the sweep deletes reachable rows unconditionally.
 *   The damage outlives the row: the next trigger then takes the INSERT path
 *   instead of the revival UPDATE, `attempts` resets to 0, and a deterministic
 *   failure gets a fresh retry budget every maintenance pass — `MAX_CLAIMS`
 *   silently bypassed, a poison job burning an LLM call forever and never
 *   dead-lettering. `COALESCE(..., 0)` makes SQL and `readRevision` give the
 *   same answer about the same state, which is the whole point of moving one
 *   rule to the data side: two readings of one rule is just a second rule.
 *
 * That agreement rests on an invariant worth stating, because the two readings
 * only coincide while it holds: `store_revision` is always the canonical
 * integer string the invalidate trigger writes. SQL `CAST` and JS `Number`
 * disagree on anything else — `'0x0b'` is 0 to one and 11 to the other, `'1e2'`
 * is 1 and 100 — so a hand-edited value could put them back out of step. The
 * trigger's `CAST(CAST(v AS INTEGER) + 1 AS TEXT)` restores the canonical form
 * on its next write, and a store whose revision is unparseable has already
 * lost `runRebuildJob`'s fencing (`NaN !== NaN` never matches), so this is
 * recorded as a limit rather than defended against.
 *
 * Everything else keeps the full 30 days on purpose. Those dead letters ARE
 * reachable — `enqueueJob` revives a failed row on the next trigger — and an
 * `extract` dead letter that is NOT revived (its id is fixed to one session
 * turn, which never recurs) is the only surviving evidence that one turn's
 * distillation was permanently abandoned. Deleting it early would erase the
 * loss, not repair it.
 */
export const cleanupJobs = (store: OpenStore, now: number): void => {
  store.tx(() => {
    store.db
      .prepare(`DELETE FROM jobs WHERE state = 'done' AND completed_at < ?`)
      .run(now - DONE_RETENTION_MS)
    store.db
      .prepare(`DELETE FROM jobs WHERE state = 'failed' AND completed_at < ?`)
      .run(now - FAILED_RETENTION_MS)
    store.db
      .prepare(
        `DELETE FROM jobs
          WHERE state = 'failed' AND kind = 'rebuild'
            AND json_valid(payload)
            AND json_extract(payload, '$.expectedRevision')
                IS NOT COALESCE(
                  (SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'store_revision'), 0)`,
      )
      .run()
  })
}
