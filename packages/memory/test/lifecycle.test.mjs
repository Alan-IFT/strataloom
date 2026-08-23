/**
 * §10 lifecycle domain: the plugin loads into a REAL cordis root with the
 * real platform services (system-prompt, tools, agents, timer), registers its
 * global contributions, and tears everything down on dispose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as memoryPlugin from '../lib/index.js'
import { tempRoot, cleanup } from './helpers.mjs'

/** Boot a root with the platform services this plugin hard-depends on. */
const boot = async (rootDir) => {
  const ctx = new Context()
  const platform = [
    ctx.plugin(Timer),
    ctx.plugin(SystemPrompt, {}),
    ctx.plugin(ToolRuntime, {}),
    ctx.plugin(AgentRegistry),
  ]
  await Promise.all(platform)
  const fiber = ctx.plugin(memoryPlugin, { rootDir })
  await fiber
  /** Tear the whole root down so no platform timer outlives the test. */
  const shutdown = async () => {
    await fiber.dispose()
    for (const entry of [...platform].reverse()) await entry.dispose()
  }
  return { ctx, fiber, shutdown }
}

test('plugin loads into a real cordis root and registers its global contributions', async () => {
  const root = tempRoot()
  const { ctx, fiber, shutdown } = await boot(root)

  assert.ok(ctx.memory, 'ctx.memory service is published')

  const assembly = await ctx.systemPrompt.assemble({})
  assert.deepEqual(
    assembly.tools.map((tool) => tool.name).sort(),
    ['memory_forget', 'memory_propose', 'memory_recall'],
  )
  assert.ok(assembly.sections.map((section) => section.name).includes('strataloom:memory-guidance'))
  // One context provider, registered globally. With no agent on the assembly
  // it contributes empty text (fail open) rather than throwing.
  const contexts = assembly.contexts.filter((entry) => entry.name === 'strataloom:memory')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].text, '')

  await fiber.dispose()
  const after = await ctx.systemPrompt.assemble({})
  assert.deepEqual(after.tools, [])
  assert.ok(!after.sections.map((s) => s.name).includes('strataloom:memory-guidance'))
  assert.equal(after.contexts.filter((e) => e.name === 'strataloom:memory').length, 0)
  assert.equal(ctx.get('memory'), undefined)

  await shutdown()
  cleanup(root)
})

test('dispose closes stores; a fresh boot on the same root re-opens cleanly', async () => {
  const root = tempRoot()
  const first = await boot(root)
  const memory = first.ctx.memory
  await first.shutdown()

  const second = await boot(root)
  assert.ok(second.ctx.memory)
  assert.notEqual(second.ctx.memory, memory)
  await second.shutdown()
  cleanup(root)
})

test('reload (HMR-shaped): global contributions come back immediately, no backfill state', async () => {
  const root = tempRoot()
  const { ctx, fiber, shutdown } = await boot(root)
  await fiber.dispose()

  const reloaded = ctx.plugin(memoryPlugin, { rootDir: root })
  await reloaded
  const assembly = await ctx.systemPrompt.assemble({})
  assert.equal(assembly.tools.length, 3)
  await reloaded.dispose()

  await shutdown()
  cleanup(root)
})
