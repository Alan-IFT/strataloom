/**
 * §10 command domain: `/memory` against the REAL command runtime.
 *
 * The command exists because the plugin learns silently, so a person needs to
 * see the result without first guessing a search term. It is a command rather
 * than a UI panel because `CommandInvocation` carries the exact live agent —
 * the same D1 predicates guard it as guard the tools, with no second
 * permission path, which the subagent case below pins down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import * as memoryPlugin from '../lib/index.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { tempRoot } from './helpers.mjs'

test('/memory lists what was learned, forgets by id, and keeps the D1 boundary', async (t) => {
  clearRepoIdentityMemo()
  const repo = join(tempRoot(),'r'); mkdirSync(repo,{recursive:true})
  execFileSync('git',['init','-q'],{cwd:repo})
  const ctx = new Context()
  const platform = [
    ctx.plugin(Timer), ctx.plugin(SystemPrompt, {}), ctx.plugin(ToolRuntime, {}),
    ctx.plugin(AgentRegistry), ctx.plugin(SessionStore), ctx.plugin(LlmRuntime, {}),
    ctx.plugin(AgentLoop, {}), ctx.plugin(Commands),
  ]
  await Promise.all(platform)
  const fiber = ctx.plugin(memoryPlugin, { rootDir: tempRoot() })
  await fiber
  let child

  // Tear the root down. The plugin owns a 30s interval, so a test that leaks
  // its fiber keeps the whole run alive — invisible under
  // `--test-force-exit`, and a hang under plain `npm run verify`.
  //
  // ⛔ REGISTERED HERE RATHER THAN RUN AT THE TAIL, and the placement is the
  // point: at the tail, any failing assertion below skips it, the fiber
  // survives, and the failure becomes a HANG instead of a report. Measured on
  // this exact file: a never-matching assertion left `cancelled 1` and RC=124
  // under an external 40s timeout. `--test-timeout` does not bound it, because
  // the test itself finished in ~44ms — what hangs is the FILE.
  t.after(async () => {
    await child?.dispose?.()
    await fiber.dispose()
    for (const entry of [...platform].reverse()) await entry.dispose()
  })

  // ⛔ REGISTERED SECOND ON PURPOSE — DO NOT FOLD THIS INTO THE TEST BODY.
  // `t.after` callbacks run FIFO, so this one observes the state the teardown
  // above left behind; asserting the same thing in the body would be vacuous,
  // since at that moment teardown legitimately has not run yet. This is what
  // separates a real teardown from an emptied one: gutting the callback above
  // leaves the named test green, and only the file-level RC=124 notices.
  // `fiber.uid` is the discriminator — a number while live, `null` once
  // disposed. `ctx.get('memory')` would also flip (measured: an object while
  // live, `undefined` after teardown; it does NOT throw), but it reports only
  // that the memory service was unpublished and says nothing about the
  // PLATFORM fibers, which this test also asserts on: a live platform fiber is
  // direct evidence that the teardown above did not run to completion.
  //
  // That second assertion is NOT about timers. Measured: the 30s interval is
  // held by the PLUGIN fiber alone — disposing it drops the process to zero
  // active Timeouts even with all 8 platform fibers deliberately leaked, and
  // the run still exits in ~0.12s. The platform check earns its place as a
  // completeness check on the teardown, nothing more.
  t.after(() => {
    assert.equal(fiber.uid, null, 'teardown really disposed the plugin fiber')
    assert.equal(
      platform.filter((entry) => entry.uid !== null).length,
      0,
      'teardown really disposed every platform fiber',
    )
  })

  const { agent } = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })

  const run = (input) => ctx.commands.execute(agent, `/memory${input ? ' ' + input : ''}`, [], new AbortController().signal)

  // 空库
  let r = await run('')
  assert.match(r.result.text, /Nothing remembered yet/)

  // 存两条后列出
  const call = (n,a) => ctx.tools.execute({ callId: randomUUID(), name:n, agent, signal:new AbortController().signal, arguments:a })
  const saved = await call('memory_propose', { title:'uses pnpm', body:'this repo uses pnpm not npm', kind:'fact' })
  await call('memory_propose', { title:'be terse', body:'short answers', kind:'preference', scope:'personal' })

  r = await run('')
  assert.match(r.result.text, /This repository/)
  assert.match(r.result.text, /Everywhere \(personal\)/)
  assert.match(r.result.text, /uses pnpm/)

  // forget
  r = await run(`forget ${saved.value.id}`)
  assert.match(r.result.text, /tombstoned/)
  r = await run('')
  assert.doesNotMatch(r.result.text, /uses pnpm/, 'forgotten entry leaves the list')

  // 错误用法
  assert.equal((await run('bogus')).result.kind, 'error')
  assert.equal((await run('forget')).result.kind, 'error')
  assert.equal((await run('forget no-such-id')).result.kind, 'error')

  // D1: the command runs in an agent context, so a subagent is refused the
  // write exactly as it is through the tool — no second permission path.
  child = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: repo, parentSession: agent.id, origin: 'subagent', delegationDepth: 1 },
  })
  const kept = await call('memory_propose', { title: 'survivor', body: 'still here', kind: 'fact' })
  const refused = await ctx.commands.execute(
    child.agent, `/memory forget ${kept.value.id}`, [], new AbortController().signal,
  )
  assert.equal(refused.result.kind, 'error')
  assert.match(refused.result.text, /principal/i, 'subagent refused, same wording as the tool')
  // Listing is a READ, so the subagent may still do it.
  const listed = await ctx.commands.execute(child.agent, '/memory', [], new AbortController().signal)
  assert.equal(listed.result.kind, 'success')
  assert.match(listed.result.text, /survivor/, 'reads stay open to any live agent')
})
