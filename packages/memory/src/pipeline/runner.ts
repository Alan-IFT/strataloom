/**
 * Job runner (spec §5.2 调度): one tick every 30s, single-flight, polls all
 * open stores, claims at most one job per store per tick (throughput is a
 * runtime parameter — widen only when P1 metrics show congestion). Claims are
 * skipped while the store's principal agent is running (peek before claim so
 * a voluntary skip never inflates attempts).
 * @module @strataloom/dsh-memory/pipeline/runner
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StoreRegistry, OpenStore } from '../store/store.ts'
import {
  CLEANUP_INTERVAL_MS,
  JOB_TIMEOUT_MS,
  LEASE_DURATION_MS,
} from '../constants.ts'
import {
  claimNextJob,
  cleanupJobs,
  enqueueJob,
  jobId,
  failClaimedJob,
  isPoisoned,
  peekClaimable,
  FencingError,
  type ClaimedJob,
  type JobKind,
} from './jobs.ts'
import { runExtractJob, type ExtractPayload, type ReconcilePayload } from './extract.ts'
import { runReconcileJob } from './reconcile.ts'
import { pruneConversations } from '../store/conversations.ts'
import { collectMetrics } from '../metrics.ts'
import { isBusy } from '../store/tx.ts'
import { runDecayJob } from './decay.ts'
import { enqueueRebuildIfOverflowing, runRebuildJob, type RebuildPayload } from './rebuild.ts'

/** Everything a job handler is given; each uses the part it needs. */
interface JobRun {
  readonly ctx: Context
  readonly store: OpenStore
  readonly job: ClaimedJob
  readonly payload: never
  readonly signal: AbortSignal
}

/**
 * One handler per job kind. A table rather than a branch chain: the type
 * makes the mapping exhaustive, so adding a kind to `JobKind` fails to
 * compile until it is handled here.
 */
const HANDLERS: Record<JobKind, (run: JobRun) => Promise<void>> = {
  extract: ({ ctx, store, job, payload, signal }) =>
    runExtractJob(ctx, store, job, payload as ExtractPayload, signal),
  reconcile: ({ ctx, store, job, payload, signal }) =>
    runReconcileJob(ctx, store, job, payload as ReconcilePayload, signal),
  rebuild: ({ ctx, store, job, payload, signal }) =>
    runRebuildJob(ctx, store, job, payload as RebuildPayload, signal).then(() => undefined),
  decay: async ({ ctx, store, job }) => {
    const report = runDecayJob(store, job, Date.now())
    ctx.logger.info('strataloom decay', { store: store.repoKey, ...report })
  },
}

/**
 * The periodic maintenance pass for one store: report, tidy, and queue the
 * self-scheduling jobs. Grouped here so the runner stays a scheduler — it
 * decides WHEN work happens, not what maintenance means.
 */
const maintain = (ctx: Context, store: OpenStore, now: number): void => {
  // Pure observation, guarded on its own: a metrics snapshot must not have the
  // power to stop the system it is measuring. Everything below MUTATES the
  // store and stays all-or-nothing — a failed write means maintenance did not
  // happen and must be seen as such — but this line only READS and then hands
  // the numbers to a logger, so aborting the pass on its behalf trades real
  // maintenance for a log line.
  //
  // The guard costs nothing under the contention that actually breaks this
  // pass: SQLITE_BUSY strikes writers, and these reads return normally while a
  // writer holds the lock (measured), so this catch never swallows a busy
  // error and never spends a busy-retry budget.
  //
  // One reason is the logger exporter: it is injected by the deployment, lives
  // outside this repository, and cannot be audited from here — which is why it
  // must not hold a veto over maintenance. That reach is narrower than it
  // sounds, and saying so is the point: this catch covers the exporter's INFO
  // call only. The `warn` below is outside it, so an exporter that throws on
  // every channel still aborts the pass. Closing that would mean wrapping
  // every log call in the runner, which buys little for a failure mode nobody
  // has reported — but the limit belongs in writing rather than in a reader's
  // assumption.
  //
  // Its reach over BAD DATA is narrow, and the narrowness is measured rather
  // than assumed: dropping each table in turn, only `usage` lets this guard
  // rescue the WHOLE pass, because it is the sole table that observation reads
  // and no maintenance write step touches. Break `conversations`, `memories`
  // or `jobs` instead and the guard merely defers the throw by one step —
  // `pruneConversations`, `enqueueRebuild…` and `cleanupJobs` respectively hit
  // the same damage. So this is not general protection against poisoned data;
  // the principle it enforces is the one below.
  try {
    ctx.logger.info('strataloom metrics', collectMetrics(store, now))
  } catch (error) {
    ctx.logger.warn(`strataloom: metrics unavailable for store ${store.repoKey}:`, error)
  }
  cleanupJobs(store, now)
  // L0 is bulky and its purpose is finite; rows a live memory cites are
  // exempt, so a memory never outlives the words behind it.
  pruneConversations(store, now)
  // Both are leased jobs rather than inline work, so they inherit fencing
  // and the busy-agent deferral instead of needing their own concurrency
  // story (§12).
  enqueueJob(
    store,
    'decay',
    jobId('decay', store.repoKey, new Date(now).toISOString().slice(0, 10)),
    {},
    now,
  )
  enqueueRebuildIfOverflowing(ctx, store, now)
}

/** Answers "is any principal agent with work in this store currently running?". */
export type BusyProbe = (store: OpenStore) => boolean

/** Single-flight leased job runner. */
export class JobRunner {
  private running = false
  private stopped = false
  private lastCleanup = 0
  private readonly abort = new AbortController()
  private settled: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly stores: StoreRegistry,
    private readonly busy: BusyProbe,
  ) {}

  /** One scheduler tick. Fire-and-forget from ctx.interval; single-flight. */
  tick(): void {
    if (this.running || this.stopped) return
    this.running = true
    this.settled = this.run().finally(() => {
      this.running = false
    })
  }

  /** Await the in-flight tick (used by dispose and by tests). */
  whenSettled(): Promise<void> {
    return this.settled
  }

  /** Stop claiming, abort in-flight LLM work, resolve when settled (spec §8). */
  async dispose(): Promise<void> {
    this.stopped = true
    this.abort.abort(new Error('strataloom runner disposed'))
    await this.settled
  }

  private async run(): Promise<void> {
    const now = Date.now()
    const doCleanup = now - this.lastCleanup > CLEANUP_INTERVAL_MS
    if (doCleanup) this.lastCleanup = now
    for (const store of this.stores.all()) {
      if (this.stopped) return
      // Maintenance is guarded SEPARATELY from job claiming, because the two
      // are independent duties that happen to share a tick. Sharing one try
      // block made a maintenance failure cancel the whole store's pipeline for
      // that tick: with `collectMetrics` throwing, a pending extract job in the
      // same store stayed at `attempts = 0` — one broken periodic chore, zero
      // jobs run.
      //
      // `maintain` itself keeps its all-or-nothing semantics: it still aborts
      // on the first throw and only logs. That is deliberate under the failure
      // that actually occurs here — SQLITE_BUSY from a second process on the
      // same repository, which hits its WRITE steps. `sleepSync` blocks the
      // event loop via `Atomics.wait`, so each write step that exhausts its
      // budget freezes for BUSY_TIMEOUT_MS * (IMMEDIATE_TX_RETRIES + 1) = 8s.
      // Stopping at the first throw pays that once; guarding each step
      // individually would pay it per step (~24s). Under contention,
      // all-or-nothing IS the early exit — a feature, not a gap (ADR 0006).
      if (doCleanup) {
        try {
          maintain(this.ctx, store, now)
        } catch (error) {
          this.ctx.logger.warn(
            `strataloom: maintenance failed for store ${store.repoKey}:`,
            error,
          )
          // A busy failure already PROVED another process holds the write
          // lock. `claimNextJob` is itself an `immediateTx` with its own full
          // retry budget, so continuing would re-lose the same race and pay a
          // SECOND ~8s freeze — the very arithmetic that rejects per-step
          // guards, applied to the step that happens to live outside the try
          // block (measured: 16936ms, and `attempts` still 0).
          //
          // Non-busy failures (bad or poisoned data) leave the lock free, so
          // claiming proceeds: that is the connection this split exists to
          // break, and it stays broken for every failure that does not carry
          // this specific proof.
          if (isBusy(error)) continue
        }
      }
      try {
        if (peekClaimable(store, now) === undefined) continue
        if (this.busy(store)) continue // heavy jobs wait for agent idle
        const job = claimNextJob(store, now, now + LEASE_DURATION_MS)
        if (job === undefined) continue
        await this.runJob(store, job)
      } catch (error) {
        this.ctx.logger.warn(`strataloom: tick failed for store ${store.repoKey}:`, error)
      }
    }
  }

  private async runJob(store: OpenStore, job: ClaimedJob): Promise<void> {
    if (isPoisoned(job)) {
      this.ctx.logger.warn(
        `strataloom: job ${job.id} (${job.kind}) dead-lettered after ${job.attempts} claims`,
      )
      // Keep whatever cause the LAST real attempt recorded: the dead-letter
      // pass never ran the handler, so it has no diagnosis of its own and
      // must not overwrite the one that explains the failure.
      failClaimedJob(store, job.id, job.leaseToken, job.attempts, true)
      return
    }
    // Cooperative timeout: a duplicate-work reducer, not a correctness bound
    // (correctness is the pre-commit CAS — spec §5.2).
    const timeout = AbortSignal.timeout(JOB_TIMEOUT_MS)
    const signal = AbortSignal.any([timeout, this.abort.signal])
    try {
      await HANDLERS[job.kind]({
        ctx: this.ctx,
        store,
        job,
        payload: JSON.parse(job.payload) as never,
        signal,
      })
    } catch (error) {
      if (error instanceof FencingError) {
        // Lease lost: successor owns the job; zero business writes happened.
        this.ctx.logger.info(`strataloom: ${error.message} (yielding to successor)`)
        return
      }
      this.ctx.logger.warn(`strataloom: job ${job.id} (${job.kind}) failed:`, error)
      try {
        failClaimedJob(store, job.id, job.leaseToken, job.attempts, false, error)
      } catch (exitError) {
        this.ctx.logger.warn(`strataloom: retry exit for ${job.id} failed:`, exitError)
      }
    }
  }
}
