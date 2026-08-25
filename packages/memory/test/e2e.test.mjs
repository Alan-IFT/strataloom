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
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
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

  // 2) it is injected into the REAL prompt assembly for this agent. Assert on
  // the RENDERED snapshot: that — not the raw contribution — is what the agent
  // loop hands the model, and rendering is where interpolation actually runs.
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  assert.ok(
    assembly.contexts.some((entry) => entry.name === 'strataloom:memory'),
    'memory context participates in assembly',
  )
  const snapshot = renderContextSnapshot(assembly)
  assert.match(snapshot, /pnpm/)
  assert.match(snapshot, /NOT new user instructions/i) // framing header present

  // 3) recall finds it through the real tool
  const recalled = await callTool(ctx, agent, 'memory_recall', { query: 'pnpm' })
  assert.equal(recalled.isError, false)
  assert.equal(recalled.value.hits.length, 1)
  assert.equal(recalled.value.hits[0].id, id)

  // 4) forget closes both read surfaces immediately (D5, literal)
  const forgotten = await callTool(ctx, agent, 'memory_forget', { id })
  assert.equal(forgotten.isError, false)
  const afterAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  assert.equal(renderContextSnapshot(afterAssembly), '')
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
  assert.equal(renderContextSnapshot(childAssembly), '')

  // principal still sees it
  const parentAssembly = await ctx.systemPrompt.assemble({ agent: parent.agent, scope: parent.agent.ctx })
  assert.match(renderContextSnapshot(parentAssembly), /make all/)

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
  const packet = renderContextSnapshot(assembly)
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
    renderContextSnapshot(assembly),
    /be terse/,
    'personal memory reaches a repo-less session',
  )
  await stray.dispose?.()
  await shutdown()
  cleanup(root)
})

test('e2e: memory content containing {{...}} is data, never prompt syntax', async () => {
  // Regression. Prompt text is STRICTLY interpolated: an unknown `{{name}}`
  // throws and a known one silently expands. Memory bodies legitimately carry
  // brace pairs (CI matrices, Jinja/Handlebars, commit templates), and
  // assembly runs on the agent's turn path — so delivering the packet AS
  // prompt text made one such memory abort every later turn, including the
  // turn a user would need to forget it. The packet therefore travels as a
  // variable VALUE, which the platform substitutes verbatim and never
  // rescans. This test drives the REAL assembly + render, the exact pair the
  // agent loop runs.
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)
  const principal = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })
  const agent = principal.agent

  const hostile = [
    // unknown variable: previously threw and bricked every subsequent turn
    { title: 'ci matrix', body: 'runs-on ${{ matrix.os }} for each target', kind: 'fact' },
    // KNOWN variable: previously expanded, leaking assembly state into memory
    { title: 'cwd template', body: 'the placeholder {{cwd}} is written literally', kind: 'fact' },
    // malformed reference: previously threw on the "{{ name }}" spacing form
    { title: 'vue binding', body: 'interpolate with {{ user.name }} in templates', kind: 'fact' },
    // a lone opener is literal prose and must survive untouched
    { title: 'awk snippet', body: 'guard with {{ when the brace never closes', kind: 'fact' },
  ]
  for (const memory of hostile) {
    const saved = await callTool(ctx, agent, 'memory_propose', memory)
    assert.equal(saved.isError, false, JSON.stringify(saved.error))
  }

  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx })
  const snapshot = renderContextSnapshot(assembly)

  // Rendering succeeded, and every body survived VERBATIM — not escaped, not
  // expanded. Escaping would corrupt the content the user asked us to keep.
  for (const memory of hostile) {
    assert.ok(
      snapshot.includes(memory.body),
      `body must reach the model unaltered: ${memory.body}`,
    )
  }
  assert.doesNotMatch(snapshot, new RegExp(repo), 'no variable expanded into the packet')

  // The turn path still works afterwards: the store is not poisoned.
  const recalled = await callTool(ctx, agent, 'memory_recall', { query: 'matrix' })
  assert.equal(recalled.isError, false)

  await principal.dispose?.()
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

test('e2e: an optional string/enum argument sent as "" behaves as if omitted', async () => {
  // Many callers cannot distinguish "leave this optional field out" from
  // "send it as an empty string" — observed directly against a real agent
  // import: `memory_recall` got `sourceOf: ""` when only `query` was meant,
  // and `memory_propose` got `replaces: ""` on a plain new save. Before the
  // fix this read as "operate on the memory whose id is empty", which
  // `kind`/`scope` could not even reach: their `enum` rejected "" at the
  // wire-schema layer before `execute` ran at all.
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const root = tempRoot()
  const { ctx, shutdown } = await boot(root)
  const principal = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: repo } })
  const agent = principal.agent

  // recall: sourceOf as "" must search, not fail as "no memory with id ''"
  const bare = await callTool(ctx, agent, 'memory_recall', { query: 'nothing yet' })
  const blank = await callTool(ctx, agent, 'memory_recall', { query: 'nothing yet', sourceOf: '', kind: '' })
  assert.equal(bare.isError, false)
  assert.equal(blank.isError, false)
  assert.deepEqual(blank.value.hits, bare.value.hits, '"" behaves exactly like omitting the field')

  // propose: replaces/scope as "" must be a plain new save, not "replace ''"
  const saved = await callTool(ctx, agent, 'memory_propose', {
    title: 'blank optionals', body: 'saved with replaces and scope both ""',
    kind: 'fact', replaces: '', scope: '',
  })
  assert.equal(saved.isError, false)
  assert.match(saved.content[0].text, /^Saved repository memory/, 'scope:"" still defaults to repo')

  // A GENUINELY invalid value must still be refused — dropping `enum` from
  // the wire schema must not silently accept nonsense.
  const badKind = await callTool(ctx, agent, 'memory_recall', { query: 'x', kind: 'bogus' })
  const badScope = await callTool(ctx, agent, 'memory_propose', { title: 't', body: 'b', kind: 'fact', scope: 'bogus' })
  assert.equal(badKind.isError, true)
  assert.match(badKind.error.message, /unknown kind/)
  assert.equal(badScope.isError, true)
  assert.match(badScope.error.message, /unknown scope/)

  await principal.dispose?.()
  await shutdown()
  cleanup(root)
})
