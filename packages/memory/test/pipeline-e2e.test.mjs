/**
 * §10 pipeline domain against the REAL LlmRuntime: a registered LlmAdapter
 * replays fixtures through actual provider routing. This is what proves the
 * route-pinning and fallback behavior, which a hand-rolled `llm` double
 * cannot: the double would validate my own assumption about routing rather
 * than the platform's routing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { runExtractJob } from '../lib/pipeline/extract.js'
import { runReconcileJob } from '../lib/pipeline/reconcile.js'
import { callPipelineLlm, PipelineLlmError } from '../lib/pipeline/llm-call.js'
import { enqueueJob, claimNextJob } from '../lib/pipeline/jobs.js'
import { captureTurn } from '../lib/store/conversations.js'
import { collectTurnEvents } from '../lib/transcript.js'
import {
  openRegistry,
  cleanup,
  turnEvents,
  userMessageEvent,
  assistantMessageEvent,
} from './helpers.mjs'

/**
 * A fixture-replaying adapter: each provider route maps to a scripted reply
 * (or an error). Records every call so routing can be asserted.
 */
class FixtureAdapter extends LlmAdapter {
  constructor(scripts) {
    super()
    this.scripts = scripts
    this.calls = []
  }

  async *stream(options) {
    this.calls.push(`${options.provider}/${options.model}`)
    const script = this.scripts[options.provider]
    if (script === undefined || script.kind === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'route down' } } }
      return
    }
    if (script.kind === 'abort') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } }
      return
    }
    if (script.kind === 'max-tokens') {
      // A reply cut at the output cap: real text, then a non-stop finish.
      yield { type: 'text-delta', index: 0, text: script.text }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    for (const piece of script.text.match(/.{1,20}/gs) ?? []) {
      yield { type: 'text-delta', index: 0, text: piece }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boot a root with the real LlmRuntime and one fixture adapter. */
const bootLlm = async (scripts, defaultSelection) => {
  const ctx = new Context()
  const platform = [ctx.plugin(Timer), ctx.plugin(LlmRuntime, {})]
  if (defaultSelection !== undefined) {
    platform.push(ctx.plugin(AgentDefaultModel, defaultSelection))
  }
  await Promise.all(platform)
  const adapter = new FixtureAdapter(scripts)
  const release = ctx.llm.registerAdapter(Object.keys(scripts), adapter)
  return {
    ctx,
    adapter,
    shutdown: async () => {
      release()
      for (const entry of [...platform].reverse()) await entry.dispose()
    },
  }
}

const claim = (store) => {
  const now = Date.now()
  return claimNextJob(store, now, now + 60_000)
}

const extractPayload = {
  sessionId: 'sess-1',
  turn: 1,
  provider: 'pinned',
  model: 'pinned-model',
  promptVersion: 1,
  payloadVersion: 1,
}

/** Seed L0 exactly as the turn boundary does (the extract job reads it). */
const seedL0 = (store, events, turn = 1, sessionId = 'sess-1') => {
  store.tx(() => captureTurn(store, sessionId, turn, collectTurnEvents(events, turn)))
}

const transcript = turnEvents(1, [
  userMessageEvent('we always deploy with make deploy in this repo'),
  assistantMessageEvent(1, 'understood, recording the deploy procedure'),
])

test('real routing: pinned route serves the extract when healthy', async () => {
  const reply = JSON.stringify({
    candidates: [
      { title: 'deploy with make deploy', body: 'run make deploy', kind: 'procedure', sourceSeqs: [2] },
    ],
  })
  const { ctx, adapter, shutdown } = await bootLlm({ pinned: { kind: 'reply', text: reply } })
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  seedL0(store, transcript)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)

  await runExtractJob(ctx, store, claim(store), extractPayload, new AbortController().signal)

  assert.deepEqual(adapter.calls, ['pinned/pinned-model'])
  const row = store.db.prepare(`SELECT status, provenance, title FROM memories`).get()
  assert.equal(row.status, 'candidate')
  assert.equal(row.provenance, 'human') // cited seq 2 = the user message
  registry.dispose()
  cleanup(root)
  await shutdown()
})

test('real routing: a dead pinned provider falls back to the default selection exactly once', async () => {
  const reply = JSON.stringify({ candidates: [] })
  const { ctx, adapter, shutdown } = await bootLlm(
    { pinned: { kind: 'error' }, backup: { kind: 'reply', text: reply } },
    { provider: 'backup', model: 'backup-model' },
  )
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  seedL0(store, transcript)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)

  await runExtractJob(ctx, store, claim(store), extractPayload, new AbortController().signal)

  // pinned attempted first, then the default selection — one fallback, no loop
  assert.deepEqual(adapter.calls, ['pinned/pinned-model', 'backup/backup-model'])
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'e1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
  await shutdown()
})

test('real routing: aborted and errored finishes both reach the retry exit', async () => {
  for (const kind of ['error', 'abort']) {
    const { ctx, shutdown } = await bootLlm({ pinned: { kind } })
    await assert.rejects(
      callPipelineLlm(
        ctx,
        { provider: 'pinned', model: 'm' },
        'sys',
        'user',
        new AbortController().signal,
      ),
      PipelineLlmError,
      `finish kind ${kind} must fail loud`,
    )
    await shutdown()
  }
})

test('real routing: a reply cut at the output cap fails loud, not as bad JSON', async () => {
  // Found against a LIVE model, which the fixture adapter could not surface
  // because it always finished as `stop`. `max-tokens` used to fall through to
  // "finished", so a truncated reply reached the parser and was reported as
  // "not valid JSON" — the wrong diagnosis, and the retry then re-ran the same
  // oversized request. Three replies in five arrived truncated mid-string.
  const { ctx, shutdown } = await bootLlm({
    pinned: { kind: 'max-tokens', text: '{"scenarios":[{"title":"Auth","body":"cut here' },
  })
  await assert.rejects(
    callPipelineLlm(ctx, { provider: 'pinned', model: 'm' }, 'sys', 'user', new AbortController().signal),
    (error) => {
      assert.ok(error instanceof PipelineLlmError)
      assert.match(error.message, /max-tokens/, 'the cause must name the cap, not the JSON')
      return true
    },
  )
  await shutdown()
})

test('the output cap covers the worst reply the prompts invite, priced as CJK', async () => {
  // The live failure this locks down: of four rebuild jobs ever run, the two
  // with small inputs finished on attempt 1 and the one summarising 27 mostly
  // Chinese memories burned all six attempts, while extract/reconcile/decay
  // went 68/0 over the same routes and days. The rollup prompt invites
  // 6 x (60 + 900 + 30) = 5940 characters; in Chinese that is ~5940 tokens
  // against a cap that was 4000, so the reply came back truncated — and a
  // truncated reply is unparseable, not merely short.
  //
  // The old guard hid this: it priced the worst case as `chars/4 * 2`, which
  // is still half the real CJK cost, so it passed while the cap was too small.
  // Asserting the RULE rather than the numbers means raising a target without
  // raising the cap fails here instead of in production.
  const {
    LLM_MAX_TOKENS,
    ROLLUP_MAX_SCENARIOS,
    ROLLUP_TARGET_CHARS,
    ROLLUP_TITLE_TARGET_CHARS,
    EXTRACT_MAX_CANDIDATES,
    EXTRACT_TITLE_TARGET_CHARS,
    EXTRACT_BODY_TARGET_CHARS,
    PERSONA_TARGET_CHARS,
  } = await import('../lib/constants.js')

  const worstReplyChars = Math.max(
    ROLLUP_MAX_SCENARIOS * (ROLLUP_TITLE_TARGET_CHARS + ROLLUP_TARGET_CHARS + 30),
    EXTRACT_MAX_CANDIDATES * (EXTRACT_TITLE_TARGET_CHARS + EXTRACT_BODY_TARGET_CHARS + 60),
    PERSONA_TARGET_CHARS + 60,
  )
  // One token per character is the honest CJK price; `chars/4` is a Latin
  // estimate and belongs to packet budgeting, not to this guard.
  assert.ok(
    LLM_MAX_TOKENS >= worstReplyChars,
    `LLM_MAX_TOKENS (${LLM_MAX_TOKENS}) must cover ${worstReplyChars} CJK tokens`,
  )
})

test('real routing: an unregistered provider fails without a fallback service', async () => {
  const { ctx, shutdown } = await bootLlm({ pinned: { kind: 'reply', text: '{}' } })
  await assert.rejects(
    callPipelineLlm(ctx, { provider: 'ghost', model: 'm' }, 's', 'u', new AbortController().signal),
  )
  await shutdown()
})

test('real routing: chunked deltas reassemble into valid JSON across the whole pipeline', async () => {
  // extract -> reconcile chained on one store, both through the real runtime.
  const extractReply = JSON.stringify({
    candidates: [
      { title: 'deploy with make', body: 'run make deploy', kind: 'procedure', sourceSeqs: [2] },
    ],
  })
  const { ctx, adapter, shutdown } = await bootLlm({ pinned: { kind: 'reply', text: extractReply } })
  const { root, registry } = openRegistry()
  const store = registry.open('k1')

  seedL0(store, transcript)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)
  await runExtractJob(ctx, store, claim(store), extractPayload, new AbortController().signal)

  const candidate = store.db.prepare(`SELECT id FROM memories WHERE status = 'candidate'`).get()
  assert.ok(candidate, 'extract produced a candidate')
  // The reconcile job the extract enqueued in the same commit is now claimable.
  const reconcileJob = claim(store)
  assert.equal(reconcileJob.kind, 'reconcile')
  const payload = JSON.parse(reconcileJob.payload)
  assert.deepEqual(payload.candidateIds, [candidate.id])

  // Same runtime, same adapter — only the scripted reply changes, so the
  // second stage runs through the identical routing path as the first.
  adapter.scripts['pinned'] = {
    kind: 'reply',
    text: JSON.stringify({ decisions: [{ candidateIndex: 0, action: 'activate' }] }),
  }
  await runReconcileJob(ctx, store, reconcileJob, payload, new AbortController().signal)

  const finalRow = store.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(candidate.id)
  assert.equal(finalRow.status, 'active') // full turn -> durable active memory
  assert.deepEqual(adapter.calls, ['pinned/pinned-model', 'pinned/pinned-model'])
  registry.dispose()
  cleanup(root)
  await shutdown()
})
