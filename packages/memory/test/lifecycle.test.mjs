/**
 * §10 lifecycle domain: the plugin loads into a REAL cordis root with the
 * real platform services (system-prompt, tools, agents, timer), registers its
 * global contributions, and tears everything down on dispose.
 */
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
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
  /** Tear the whole root down so nothing from this boot outlives the test. */
  const shutdown = async () => {
    await fiber.dispose()
    for (const entry of [...platform].reverse()) await entry.dispose()
  }
  // `platform` is returned alongside `fiber` so a test can assert teardown
  // actually ran: a fiber's `uid` is a number while it is live and `null` once
  // disposed, and the platform fibers are torn down ONLY by `shutdown()`.
  return { ctx, fiber, platform, shutdown }
}

test('the running build reports its own version, from the manifest', () => {
  // Updating is re-running the same install command, so this line is the only
  // way a user confirms it took effect. The version is read from the manifest
  // rather than duplicated in a constant: a second copy is a second thing to
  // bump, and the stale one would be the one users are shown.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const resolved = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.resolve('../lib/index.js')), 'utf8'),
  )
  assert.equal(resolved.version, manifest.version, 'lib/ resolves the same manifest')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'a real version, not a placeholder')
  // `package.json` must ship, or the installed build reports "unknown".
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'files list is the published set')
})

test('plugin loads into a real cordis root and registers its global contributions', async (t) => {
  const root = tempRoot()
  const { ctx, fiber, platform, shutdown } = await boot(root)

  // ⛔ A NET, NOT A MOVE. The `await fiber.dispose()` further down is part of
  // what this test ASSERTS — the lines after it check that the contributions
  // disappear — so it stays exactly where it is. This callback only guarantees
  // the root is torn down even when an assertion throws. Without it, a failing
  // assertion skips the tail teardown, the plugin's 30s interval keeps the
  // event loop alive, and the FILE hangs instead of reporting the failure
  // (measured: `cancelled 1`, RC=124 under an external 40s timeout).
  // Disposing twice is idempotent and does not throw, which is what makes a
  // backstop safe here.
  t.after(async () => {
    await shutdown()
    cleanup(root)
  })

  // ⛔ REGISTERED SECOND ON PURPOSE — DO NOT FOLD THIS INTO THE TEST BODY.
  // `t.after` runs FIFO, so this observes the state the teardown above left;
  // asserting it in the body would be vacuous, because teardown has
  // legitimately not run at that point. It is the only check that tells a real
  // teardown from an emptied one. `uid` is the discriminator — a number while
  // a fiber is live, `null` once disposed.
  //
  // It asserts on the PLATFORM fibers, not on `fiber`: this test disposes the
  // plugin fiber itself, mid-body and on purpose, so `fiber.uid` is already
  // `null` before any teardown runs and would prove nothing here. The platform
  // fibers are disposed by `shutdown()` ALONE, which is exactly the work being
  // checked.
  //
  // `ctx.get('memory')` is unusable here for the SAME reason — NOT because it
  // errors; it does not. It returns the service while live and `undefined`
  // once the memory fiber is gone, which is exactly what this test's own body
  // asserts further down. That is the problem: the mid-body `fiber.dispose()`
  // makes it `undefined` before any teardown runs, so reading it here would be
  // vacuous. Measured in general: with the plugin fiber disposed and the whole
  // platform root LEAKED it still reads `undefined`, so it cannot separate a
  // partial teardown from a complete one.
  //
  // A live platform fiber is what this probe catches, and it is asserted as
  // DIRECT EVIDENCE that the teardown did not run to completion — not as a
  // timer leak. Measured: the 30s interval belongs to the PLUGIN fiber alone,
  // and disposing that one fiber drops the process to zero active Timeouts
  // even while every platform fiber is still live.
  t.after(() => {
    assert.equal(
      platform.filter((entry) => entry.uid !== null).length,
      0,
      'teardown really disposed the platform fibers',
    )
    assert.equal(existsSync(root), false, 'teardown really removed the temp store root')
  })

  assert.ok(ctx.memory, 'ctx.memory service is published')

  const assembly = await ctx.systemPrompt.assemble({})
  assert.deepEqual(
    assembly.tools.map((tool) => tool.name).sort(),
    ['memory_forget', 'memory_propose', 'memory_recall'],
  )
  assert.ok(assembly.sections.map((section) => section.name).includes('strataloom:memory-guidance'))
  // One context provider, registered globally. Its text is a single variable
  // reference — the packet travels as a substituted VALUE so that memory
  // content can never be read as prompt syntax (see recall/inject.ts). With no
  // agent on the assembly it resolves to empty (fail open) rather than
  // throwing, and an empty context drops out of the rendered snapshot.
  const contexts = assembly.contexts.filter((entry) => entry.name === 'strataloom:memory')
  assert.equal(contexts.length, 1)
  assert.equal(assembly.variables.strataloom_memory, '')
  assert.equal(renderContextSnapshot(assembly), '')

  await fiber.dispose()
  const after = await ctx.systemPrompt.assemble({})
  assert.deepEqual(after.tools, [])
  assert.ok(!after.sections.map((s) => s.name).includes('strataloom:memory-guidance'))
  assert.equal(after.contexts.filter((e) => e.name === 'strataloom:memory').length, 0)
  assert.equal(ctx.get('memory'), undefined)
})

test('dispose closes stores; a fresh boot on the same root re-opens cleanly', async (t) => {
  const root = tempRoot()
  const first = await boot(root)
  const memory = first.ctx.memory
  let second

  // ⛔ SAFETY NET ONLY — IT DOES NOT REPLACE THE `first.shutdown()` BELOW.
  // That call is THE PREMISE of this test: the second boot must happen against
  // a root whose first fiber is already gone, which is what "re-opens cleanly"
  // means. Moving it into this callback would silently gut the test — it would
  // still report `pass 1`, because `assert.notEqual` compares two distinct
  // service instances and passes whether or not the first fiber is still
  // alive. So the premise stays inline and this is a backstop for the case
  // where an assertion throws before the tail is reached; a repeated
  // `shutdown()` is idempotent and does not throw.
  t.after(async () => {
    await second?.shutdown()
    await first.shutdown()
    cleanup(root)
  })

  await first.shutdown()
  // The premise, asserted rather than assumed: the first fiber is REALLY gone
  // before the second boot. `uid` is `null` only after a genuine dispose.
  assert.equal(first.fiber.uid, null, 'the first fiber is disposed before the second boot')
  assert.equal(
    first.platform.filter((entry) => entry.uid !== null).length,
    0,
    'and so is its whole platform root — nothing from the first boot is still live',
  )

  second = await boot(root)
  assert.ok(second.ctx.memory)
  assert.notEqual(second.ctx.memory, memory)
})

test('reload (HMR-shaped): global contributions come back immediately, no backfill state', async (t) => {
  const root = tempRoot()
  const { ctx, fiber, shutdown } = await boot(root)
  let reloaded

  // ⛔ SAFETY NET ONLY — IT DOES NOT REPLACE THE `fiber.dispose()` BELOW.
  // That dispose IS the reload being tested: the point is that contributions
  // come back after the original fiber goes away, so it stays inline. This
  // callback exists so that an assertion throwing mid-test still tears the
  // root down instead of leaving the plugin's 30s interval holding the event
  // loop open and hanging the whole FILE. Disposing twice is idempotent.
  t.after(async () => {
    await reloaded?.dispose()
    await shutdown()
    cleanup(root)
  })

  await fiber.dispose()

  reloaded = ctx.plugin(memoryPlugin, { rootDir: root })
  await reloaded
  const assembly = await ctx.systemPrompt.assemble({})
  assert.equal(assembly.tools.length, 3)
  await reloaded.dispose()
})
