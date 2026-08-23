/**
 * @strataloom/dsh-memory — plugin entry (spec §1/§8).
 *
 * Activation (top-level owner holds every resource):
 *   1. global registrations: three tools, guidance section, one context provider;
 *   2. scan + open all known stores; start the runner tick (P1).
 *
 * Dispose (single teardown, spec §8): stop enqueueing → interval disposes with
 * the fiber → runner stops claiming, aborts in-flight LLM calls, awaits
 * settled → close all stores. In-flight transactions roll back with their
 * connections; late commits are fenced (D6) — crash and graceful exit share
 * one recovery path.
 * @module @strataloom/dsh-memory
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer' // ctx.interval augmentation
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { StoreRegistry } from './store/store.ts'
import { MemoryService } from './service.ts'
import { registerTools, GUIDANCE_SECTION } from './tools.ts'
import { buildContextProvider, MEMORY_CONTEXT_TEXT, MEMORY_VARIABLE } from './recall/inject.ts'
import { JobRunner } from './pipeline/runner.ts'
import { installAutoExtract } from './auto-extract.ts'
import { TICK_INTERVAL_MS } from './constants.ts'

export const name = 'strataloom-memory'

/**
 * This build's version, read from the package manifest at load rather than
 * duplicated in a constant — a second copy is a second thing to bump, and the
 * one that goes stale is the one users are shown. Falls back to `unknown`
 * because a manifest that cannot be read is not a reason to refuse to start.
 */
const VERSION: string = (() => {
  try {
    const manifest = new URL('../package.json', import.meta.url)
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * Hard dependencies only (cordis `Inject` is an array of service names; a
 * missing one keeps the fiber PENDING). The soft deps — `llm`,
 * `agentDefaultModel` — are read through `ctx.get()` at the
 * enqueue gate and in the pipeline, so their absence disables automatic
 * extraction without disabling the plugin (spec §1/§5.1).
 */
export const inject = ['tools', 'systemPrompt', 'agents', 'timer']

/** Optional deployment config: override the store root (tests use this). */
export interface Config {
  /** Store root directory; defaults to `~/.dsh/strataloom`. */
  rootDir?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const rootDir = config.rootDir ?? dshHomePath('strataloom')
  // Say which build is running, and where its data lives. Updating is
  // re-running the same install command, so the one thing a user cannot
  // otherwise confirm is whether it took effect — and if memories seem to have
  // vanished, the answer is almost always that `rootDir` is not where they
  // looked. Deliberately NOT a version check: that would be this plugin's
  // first outbound request, and would need an offline story, a timeout, a
  // frequency nobody can justify, and a reason to send installs somewhere.
  ctx.logger.info(`strataloom ${VERSION} ready (data: ${rootDir})`)
  const stores = new StoreRegistry(rootDir, ctx.logger)
  const memory = new MemoryService(ctx, stores)

  // -- global registrations (all disposal rides this plugin's fiber) --------
  registerTools(ctx, memory)
  ctx.systemPrompt.section(GUIDANCE_SECTION)
  // The packet travels as a variable VALUE, not as context text: prompt text
  // is strictly interpolated, and stored memories legitimately contain `{{…}}`
  // (CI matrices, template syntax). As text, one such memory would throw on
  // every assembly — aborting the very turns needed to forget it — or, worse,
  // silently expand a known variable. Substituted values are never rescanned,
  // so this keeps memory content data by construction (see recall/inject.ts).
  ctx.systemPrompt.variable(MEMORY_VARIABLE, buildContextProvider(ctx, memory))
  ctx.systemPrompt.context({
    name: 'strataloom:memory',
    order: 50,
    text: MEMORY_CONTEXT_TEXT,
  })

  // -- stores + pipeline ----------------------------------------------------
  stores.openAllKnown()

  const runner = new JobRunner(ctx, stores, (store) => {
    // Busy probe: any live principal agent whose repo store is this one and
    // whose status is running defers heavy jobs (spec §5.2).
    for (const agent of ctx.agents.list()) {
      if (agent.status !== 'running') continue
      const agentStore = memory.storeFor(agent, false)
      if (agentStore === store) return true
    }
    return false
  })
  ctx.interval(() => {
    runner.tick()
  }, TICK_INTERVAL_MS)

  installAutoExtract(ctx, memory)

  // -- single teardown. Cordis disposes in reverse registration order, so
  // this effect (registered last) runs FIRST: the runner stops claiming,
  // aborts in-flight LLM calls, awaits settlement, then every store closes.
  // Interval ticks racing this window are no-ops (`stopped` latch), and the
  // turn-stopping listener fails open on a closed store. The remaining
  // fibers (interval, provider, section, tools) then unwind (spec §8).
  // Store closing is unconditional: a runner that fails to settle must not
  // leak connections, and an unclosed WAL connection is the one resource
  // whose leak outlives the process boundary. ------------------------------
  ctx.effect(
    () => async () => {
      try {
        await runner.dispose()
      } catch (error) {
        ctx.logger.warn('strataloom: runner teardown failed; closing stores anyway:', error)
      }
      stores.dispose()
    },
    'strataloom:teardown',
  )
}

export { MemoryService, MemoryAccessError, MemoryInputError } from './service.ts'
export type {
  MemoryId,
  MemoryKind,
  RecallQuery,
  RecallResult,
  RecallHit,
  MemoryCandidate,
  ForgetReport,
} from './types.ts'
