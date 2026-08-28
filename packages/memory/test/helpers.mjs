/**
 * Test helpers: temp store roots, fake agents shaped like the platform's
 * duck-typed surface, and a minimal ctx stub for units that only need
 * agents.get / logger / ctx.get.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreRegistry } from '../lib/store/store.js'

const quiet = { warn() {}, info() {}, error() {}, debug() {} }

export const tempRoot = () => mkdtempSync(join(tmpdir(), 'strataloom-test-'))

export const cleanup = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/** Open a registry over a temp root; returns { root, registry }. */
export const openRegistry = () => {
  const root = tempRoot()
  const registry = new StoreRegistry(root, quiet)
  return { root, registry }
}

/**
 * A fake Agent: only the fields the plugin reads (id, options, status,
 * session.header/id/events). `depth`/`origin` shape the lineage predicate;
 * `runtimeDepth` feeds delegationDepthOf's max(header, runtime).
 */
export const fakeAgent = ({
  id = 'sess-1',
  cwd,
  parentSession,
  origin,
  delegationDepth,
  runtimeDepth,
  events = [],
  status = 'idle',
} = {}) => {
  const header = { version: 0, id, createdAt: 0 }
  if (cwd !== undefined) header.cwd = cwd
  if (parentSession !== undefined) header.parentSession = parentSession
  if (origin !== undefined) header.origin = origin
  if (delegationDepth !== undefined) header.delegationDepth = delegationDepth
  const options = {}
  if (runtimeDepth !== undefined) options.subagentDepth = runtimeDepth
  return {
    id,
    options,
    status,
    session: { id, header, events },
  }
}

/** Minimal ctx stub: live-agent map + logger + soft-dep map. */
export const fakeCtx = ({ agents = [], services = {} } = {}) => {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  return {
    agents: {
      get: (id) => byId.get(id),
      list: () => [...byId.values()],
    },
    logger: quiet,
    get: (name) => services[name],
  }
}

/** Session event helpers for transcript-shaped tests. */
export const turnEvents = (turn, entries) => {
  let seq = 1
  const events = [{ type: 'turn/start', seq: seq++, time: 0, data: { turn } }]
  for (const entry of entries) {
    events.push({ ...entry, seq: seq++, time: 0 })
  }
  events.push({ type: 'turn/end', seq: seq++, time: 0, data: { turn, reason: 'completed' } })
  return events
}

export const userMessageEvent = (text) => ({
  type: 'user/message',
  data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

/**
 * A `user/message` carrying an arbitrary platform source shape. Continuable
 * subagents deliver their real content this way — not through tool/result —
 * so every source-kind classification test builds its event here.
 */
export const sourcedMessageEvent = (text, source) => ({
  type: 'user/message',
  data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source },
})

export const assistantMessageEvent = (turn, text) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: 0,
    message: {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  },
})

export const toolResultEvent = (turn, callId, text) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 0,
    message: {
      id: 't',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  },
})

export const toolCallEvent = (turn, callId, name) => ({
  type: 'tool/call',
  data: { turn, step: 0, callId, name, arguments: '{}' },
})
