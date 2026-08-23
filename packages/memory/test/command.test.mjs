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

test('/memory lists what was learned, forgets by id, and keeps the D1 boundary', async () => {
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
  const child = await ctx.agents.create({
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

  // Tear the root down. The plugin owns a 30s interval, so a test that leaks
  // its fiber keeps the whole run alive — invisible under
  // `--test-force-exit`, and a hang under plain `npm run verify`.
  await child.dispose?.()
  await fiber.dispose()
  for (const entry of [...platform].reverse()) await entry.dispose()
})
