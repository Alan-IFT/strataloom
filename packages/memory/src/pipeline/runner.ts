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
  ctx.logger.info('strataloom metrics', collectMetrics(store, now))
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
      try {
        if (doCleanup) maintain(this.ctx, store, now)
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
