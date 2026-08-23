/**
 * End-to-end against the REAL platform: a live agent created through the real
 * AgentRegistry, real tool dispatch through ToolRuntime, and real prompt
 * assembly. This is the test that proves the plugin works with the platform's
 * own objects rather than with test doubles.
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
import * as memoryPlugin from '../lib/index.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { tempRoot, cleanup } from './helpers.mjs'

const makeRepo = () => {
  const dir = join(tempRoot(), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const boot = async (rootDir) => {
  const ctx = new Context()
  const platform = [
    ctx.plugin(Timer),
    ctx.plugin(SystemPrompt, {}),
    ctx.plugin(ToolRuntime, {}),
    ctx.plugin(AgentRegistry),
    ctx.plugin(SessionStore),
    ctx.plugin(LlmRuntime, {}),
    ctx.plugin(AgentLoop, {}), // provides the agent factory ctx.agents.create needs
  ]
  await Promise.all(platform)
  const fiber = ctx.plugin(memoryPlugin, { rootDir })
  await fiber
  return {
    ctx,
    shutdown: async () => {
      await fiber.dispose()
      for (const entry of [...platform].reverse()) await entry.dispose()
    },
  }
}

/** Call a registered tool the way the agent loop does. */
const callTool = async (ctx, agent, name, args) =>
  ctx.tools.execute({
    callId: randomUUID(),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })

test('e2e: real agent saves, recalls, sees injection, and forgets', async () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)

  const principal = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: repo },
  })
  const agent = principal.agent

  // 1) save through the real tool pipeline
  const saved = await callTool(ctx, agent, 'memory_propose', {
    title: 'this repo uses pnpm',
    body: 'always run pnpm install, never npm install',
    kind: 'fact',
  })
  assert.equal(saved.isError, false, JSON.stringify(saved.error))
  const id = saved.value.id
  assert.ok(id)

  // 2) it is injected into the REAL prompt assembly for this agent
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  const injected = assembly.contexts.find((entry) => entry.name === 'strataloom:memory')
  assert.ok(injected, 'memory context participates in assembly')
  assert.match(injected.text, /pnpm/)
  assert.match(injected.text, /NOT new user instructions/i) // framing header present

  // 3) recall finds it through the real tool
  const recalled = await callTool(ctx, agent, 'memory_recall', { query: 'pnpm' })
  assert.equal(recalled.isError, false)
  assert.equal(recalled.value.hits.length, 1)
  assert.equal(recalled.value.hits[0].id, id)

  // 4) forget closes both read surfaces immediately (D5, literal)
  const forgotten = await callTool(ctx, agent, 'memory_forget', { id })
  assert.equal(forgotten.isError, false)
  const afterAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  const afterInjected = afterAssembly.contexts.find((e) => e.name === 'strataloom:memory')
  assert.equal(afterInjected?.text ?? '', '')
  const afterRecall = await callTool(ctx, agent, 'memory_recall', { query: 'pnpm' })
  assert.equal(afterRecall.value.hits.length, 0)

  await principal.dispose?.()
  await shutdown()
  cleanup(root)
})

test('e2e: a real subagent-shaped child is refused writes but may recall', async () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)

  const parent = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })
  // A child created the way dsh-subagent creates one: origin + depth stamped.
  const child = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: repo, parentSession: parent.agent.id, origin: 'subagent', delegationDepth: 1 },
  })

  await callTool(ctx, parent.agent, 'memory_propose', {
    title: 'build with make',
    body: 'the build entry point is make all',
    kind: 'procedure',
  })

  // subagent: propose and forget are refused with a clear message
  const proposed = await callTool(ctx, child.agent, 'memory_propose', {
    title: 'sneaky', body: 'should not persist', kind: 'fact',
  })
  assert.equal(proposed.isError, true)
  assert.match(JSON.stringify(proposed.content), /principal/i)

  // subagent: recall works (tool audience is open)
  const recalled = await callTool(ctx, child.agent, 'memory_recall', { query: 'make' })
  assert.equal(recalled.isError, false)
  assert.equal(recalled.value.hits.length, 1)

  // subagent: injection stays empty (injection audience is principal-only)
  const childAssembly = await ctx.systemPrompt.assemble({ agent: child.agent, scope: child.agent.ctx })
  const childInjected = childAssembly.contexts.find((e) => e.name === 'strataloom:memory')
  assert.equal(childInjected?.text ?? '', '')

  // principal still sees it
  const parentAssembly = await ctx.systemPrompt.assemble({ agent: parent.agent, scope: parent.agent.ctx })
  assert.match(
    parentAssembly.contexts.find((e) => e.name === 'strataloom:memory').text,
    /make all/,
  )

  await child.dispose?.()
  await parent.dispose?.()
  await shutdown()
  cleanup(root)
})

test('e2e: personal memory and L0 drill-down through the real tool pipeline', async () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)
  const principal = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })
  const agent = principal.agent

  // A personal preference and a repo fact, saved through the real tools.
  const personal = await callTool(ctx, agent, 'memory_propose', {
    title: 'reply in Chinese',
    body: 'the user prefers Chinese explanations',
    kind: 'preference',
    scope: 'personal',
  })
  assert.equal(personal.isError, false, JSON.stringify(personal.error))
  assert.match(JSON.stringify(personal.content), /personal memory/)

  const repoFact = await callTool(ctx, agent, 'memory_propose', {
    title: 'uses pnpm', body: 'this repo uses pnpm', kind: 'fact',
  })
  assert.equal(repoFact.isError, false)

  // Both scopes are injected into the real prompt, personal first.
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  const packet = assembly.contexts.find((e) => e.name === 'strataloom:memory').text
  assert.match(packet, /Chinese/)
  assert.match(packet, /pnpm/)
  assert.ok(packet.indexOf('Chinese') < packet.indexOf('pnpm'))

  // Recall spans scopes through the tool.
  const recalled = await callTool(ctx, agent, 'memory_recall', { query: 'Chinese' })
  assert.equal(recalled.value.hits.length, 1)

  // sourceOf on a memory with no captured turn returns an empty transcript
  // rather than failing — the memory exists, its conversation aged out.
  const source = await callTool(ctx, agent, 'memory_recall', { sourceOf: personal.value.id })
  assert.equal(source.isError, false)
  assert.equal(source.value.hits.length, 0)

  await principal.dispose?.()
  await shutdown()
  cleanup(root)
})

test('e2e: an agent with no repo affiliation is refused writes and injects nothing', async () => {
  clearRepoIdentityMemo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)
  // cwd outside any git work tree
  const stray = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: tempRoot() } })

  const proposed = await callTool(ctx, stray.agent, 'memory_propose', {
    title: 't', body: 'b', kind: 'fact',
  })
  assert.equal(proposed.isError, true)
  assert.match(JSON.stringify(proposed.content), /repo affiliation/i)

  // ...but a PERSONAL memory needs no repo, and is injected right here.
  const personal = await callTool(ctx, stray.agent, 'memory_propose', {
    title: 'be terse', body: 'short answers preferred', kind: 'preference', scope: 'personal',
  })
  assert.equal(personal.isError, false, 'personal scope needs no repo affiliation')

  const assembly = await ctx.systemPrompt.assemble({ agent: stray.agent, scope: stray.agent.ctx })
  assert.match(
    assembly.contexts.find((e) => e.name === 'strataloom:memory')?.text ?? '',
    /be terse/,
    'personal memory reaches a repo-less session',
  )
  await stray.dispose?.()
  await shutdown()
  cleanup(root)
})

test('e2e: parallel tool calls from one agent all commit correctly', async () => {
  // A model can request several tool calls in one step, and the registry may
  // overlap them. Every write takes the same transaction entry, so this must
  // neither lose a write nor deadlock against the reads running beside it.
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)
  const principal = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })
  const agent = principal.agent

  const calls = []
  for (let i = 0; i < 6; i++) {
    calls.push(
      callTool(ctx, agent, 'memory_propose', { title: `parallel ${i}`, body: `body ${i}`, kind: 'fact' }),
      callTool(ctx, agent, 'memory_recall', { query: 'body' }),
    )
  }
  const results = await Promise.all(calls)
  assert.equal(results.filter((r) => r.isError).length, 0, 'no call failed')

  const final = await callTool(ctx, agent, 'memory_recall', { query: 'parallel' })
  assert.equal(final.value.hits.length, 6, 'every write landed exactly once')

  await principal.dispose?.()
  await shutdown()
  cleanup(root)
})
