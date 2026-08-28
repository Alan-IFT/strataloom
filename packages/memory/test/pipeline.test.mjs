/** §10 pipeline domain: provenance mapping, extract/reconcile, route fallback. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runExtractJob } from '../lib/pipeline/extract.js'
import { collectTurnEvents, provenanceFor } from '../lib/transcript.js'
import { captureTurn } from '../lib/store/conversations.js'
import { runReconcileJob } from '../lib/pipeline/reconcile.js'
import { callPipelineLlm, parseStrictJson, PipelineLlmError } from '../lib/pipeline/llm-call.js'
import { enqueueJob, claimNextJob } from '../lib/pipeline/jobs.js'
import {
  openRegistry,
  cleanup,
  fakeCtx,
  turnEvents,
  userMessageEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
} from './helpers.mjs'

// ---- provenance mapping (spec §2.4 — full coverage incl. unknown) ---------

test('event category -> provenance mapping covers every category', () => {
  const events = turnEvents(1, [
    userMessageEvent('user says'),
    assistantMessageEvent(1, 'assistant says'),
    toolCallEvent(1, 'c1', 'bash'),
    toolResultEvent(1, 'c1', 'tool output'),
    toolCallEvent(1, 'c2', 'subagent'),
    toolResultEvent(1, 'c2', 'subagent relay'),
    {
      type: 'user/message',
      data: {
        id: 'x', role: 'user',
        content: [{ type: 'text', text: 'synthetic context' }],
        source: { kind: 'plugin', plugin: 'other' },
      },
    },
  ])
  const collected = collectTurnEvents(events, 1)
  const byLabel = new Map(collected.map((e) => [e.label, e.provenance]))
  assert.equal(byLabel.get('user'), 'human')
  assert.equal(byLabel.get('assistant'), 'parent-agent')
  assert.equal(byLabel.get('tool:bash'), 'tool-output')
  assert.equal(byLabel.get('tool:subagent'), 'subagent')
  assert.equal(byLabel.get('context'), 'tool-output') // unknown ⇒ lowest trust
})

test('mixed sources take minimum trust; unknown seqs are tool-output (fail closed)', () => {
  // The map holds classified transcript events (the same objects the runner
  // keeps for excerpts); only `provenance` matters here.
  const bySeq = new Map([
    [1, { provenance: 'human' }],
    [2, { provenance: 'parent-agent' }],
    [3, { provenance: 'tool-output' }],
  ])
  assert.equal(provenanceFor([1], bySeq), 'human')
  assert.equal(provenanceFor([1, 2], bySeq), 'parent-agent')
  assert.equal(provenanceFor([1, 3], bySeq), 'tool-output')
  assert.equal(provenanceFor([99], bySeq), 'tool-output') // unknown seq
  assert.equal(provenanceFor([], bySeq), 'tool-output') // empty
})

// ---- llm-call: strict parse + one-shot fallback ---------------------------

const streamOf = (chunks) => ({
  async *[Symbol.asyncIterator]() {
    yield* chunks
  },
})

const textStream = (text) =>
  streamOf([
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

test('pinned route failure falls back once to agentDefaultModel.currentSelection()', async () => {
  const calls = []
  const ctx = fakeCtx({
    services: {
      llm: {
        stream(options) {
          calls.push(`${options.provider}/${options.model}`)
          if (options.provider === 'gone') {
            return streamOf([{ type: 'finish', reason: { kind: 'error', failure: {} } }])
          }
          return textStream('{"ok":true}')
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'live', model: 'default' }) },
    },
  })
  const reply = await callPipelineLlm(
    ctx,
    { provider: 'gone', model: 'x' },
    'sys',
    'user',
    new AbortController().signal,
  )
  assert.deepEqual(JSON.parse(reply), { ok: true })
  assert.deepEqual(calls, ['gone/x', 'live/default'])
})

test('no default-model service: first failure propagates (retry exit)', async () => {
  const ctx = fakeCtx({
    services: {
      llm: { stream: () => streamOf([{ type: 'finish', reason: { kind: 'error', failure: {} } }]) },
    },
  })
  await assert.rejects(
    callPipelineLlm(ctx, { provider: 'p', model: 'm' }, 's', 'u', new AbortController().signal),
    PipelineLlmError,
  )
})

test('parseStrictJson: plain, fenced, and garbage', () => {
  assert.deepEqual(parseStrictJson('{"a":1}'), { a: 1 })
  assert.deepEqual(parseStrictJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.throws(() => parseStrictJson('no json here'), PipelineLlmError)
})

// ---- extract end-to-end against a real store ------------------------------

const claim = (store) => {
  const now = Date.now()
  return claimNextJob(store, now, now + 60_000)
}

const extractPayload = {
  sessionId: 'sess-1',
  turn: 1,
  provider: 'p',
  model: 'm',
  promptVersion: 1,
  payloadVersion: 1,
}

/**
 * Seed L0 the way the turn boundary does: classify the events, then capture
 * them. The extract job reads THIS — not a fake service — so these tests
 * exercise the real capture -> extract path.
 */
const seedL0 = (store, events, turn = 1, sessionId = 'sess-1') => {
  store.tx(() => captureTurn(store, sessionId, turn, collectTurnEvents(events, turn)))
}

test('extract: inserts candidates with service-mapped provenance and enqueues one reconcile', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = turnEvents(1, [
    userMessageEvent('we deploy with make deploy'),
    assistantMessageEvent(1, 'noted, deploying via make deploy'),
  ])
  // Model cites BOTH seqs — mixed human+parent-agent ⇒ parent-agent.
  const reply = JSON.stringify({
    candidates: [
      { title: 'deploy via make deploy', body: 'use make deploy', kind: 'procedure', sourceSeqs: [2, 3] },
    ],
  })
  const ctx = fakeCtx({
    services: { llm: { stream: () => textStream(reply) }},
  })
  seedL0(store, events)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)
  const job = claim(store)
  await runExtractJob(ctx, store, job, extractPayload, new AbortController().signal)

  const rows = store.db.prepare(`SELECT status, provenance, title FROM memories`).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'candidate')
  assert.equal(rows[0].provenance, 'parent-agent')
  const jobs = store.db.prepare(`SELECT kind, state FROM jobs ORDER BY created_at`).all()
  assert.deepEqual(jobs.map((j) => `${j.kind}:${j.state}`), ['extract:done', 'reconcile:pending'])
  // evidence row cites the session
  const evidence = store.db.prepare(`SELECT kind, ref FROM evidence`).all()
  assert.equal(evidence[0].ref, 'sess-1')
  registry.dispose()
  cleanup(root)
})

test('extract: tombstoned session ref suppresses the whole batch (source suppression)', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  // A tombstone citing sess-1 exists (indexed reverse lookup path).
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('dead', 'fact', 'repo-local', 'tombstone', '', '', 'human', 0, 0)`,
      )
      .run()
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES ('dead', 'session', 'sess-1')`)
      .run()
  })
  const events = turnEvents(1, [userMessageEvent('the same forgotten thing again')])
  const reply = JSON.stringify({
    candidates: [{ title: 're-learned', body: 'should be suppressed', kind: 'fact', sourceSeqs: [2] }],
  })
  const ctx = fakeCtx({
    services: { llm: { stream: () => textStream(reply) }},
  })
  seedL0(store, events)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)
  const job = claim(store)
  await runExtractJob(ctx, store, job, extractPayload, new AbortController().signal)
  const count = store.db.prepare(`SELECT count(*) c FROM memories WHERE status = 'candidate'`).get().c
  assert.equal(count, 0)
  // job is done (not retried): suppression is a decision, not a failure
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'e1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
})

test('extract: a NEW session ref can re-learn after tombstone (spec §6 promise)', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('dead', 'fact', 'repo-local', 'tombstone', '', '', 'human', 0, 0)`,
      )
      .run()
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES ('dead', 'session', 'sess-OLD')`)
      .run()
  })
  const events = turnEvents(1, [userMessageEvent('fresh evidence in a new session')])
  const reply = JSON.stringify({
    candidates: [{ title: 're-learned', body: 'new source ok', kind: 'fact', sourceSeqs: [2] }],
  })
  const ctx = fakeCtx({
    services: { llm: { stream: () => textStream(reply) }},
  })
  seedL0(store, events)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)
  const job = claim(store)
  await runExtractJob(ctx, store, job, extractPayload, new AbortController().signal)
  const count = store.db.prepare(`SELECT count(*) c FROM memories WHERE status = 'candidate'`).get().c
  assert.equal(count, 1)
  registry.dispose()
  cleanup(root)
})

test('extract: malformed model JSON throws (retry exit, no half-products)', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = turnEvents(1, [userMessageEvent('long enough content to extract')])
  const ctx = fakeCtx({
    services: { llm: { stream: () => textStream('{"candidates": [{"broken": true}]}') }},
  })
  seedL0(store, events)
  enqueueJob(store, 'extract', 'e1', extractPayload, 0)
  const job = claim(store)
  await assert.rejects(
    runExtractJob(ctx, store, job, extractPayload, new AbortController().signal),
    PipelineLlmError,
  )
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories`).get().c, 0)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'e1'`).get().state, 'running')
  registry.dispose()
  cleanup(root)
})

test('extract: a prose "nothing to remember" settles, a malformed object still retries', async () => {
  // Live failure this closes: one turn of shell and file-read output
  // dead-lettered with "model reply is not valid JSON" after six attempts,
  // while the turns either side of it — same route, same model — finished on
  // attempt 1. The prompt asks for {"candidates":[]} when a turn holds nothing
  // durable, and most turns hold nothing durable, so a model answering that in
  // prose is cooperating. Retrying it re-asks the same question of the same
  // text and can never succeed.
  for (const reply of ['', 'No reusable lessons in this turn.', '  ']) {
    const { root, registry } = openRegistry()
    const store = registry.open('k1')
    seedL0(store, turnEvents(1, [userMessageEvent('long enough content to extract')]))
    enqueueJob(store, 'extract', 'e1', extractPayload, 0)
    const ctx = fakeCtx({ services: { llm: { stream: () => textStream(reply) } } })
    await runExtractJob(ctx, store, claim(store), extractPayload, new AbortController().signal)
    assert.equal(
      store.db.prepare(`SELECT state FROM jobs WHERE id = 'e1'`).get().state,
      'done',
      `an empty answer settles the job: ${JSON.stringify(reply)}`,
    )
    assert.equal(store.db.prepare(`SELECT count(*) c FROM memories`).get().c, 0)
    registry.dispose()
    cleanup(root)
  }

  // But a reply that DOES contain an object is held to the strict parser: a
  // broken structure means the work did not happen, and that still retries.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  seedL0(store, turnEvents(1, [userMessageEvent('long enough content to extract')]))
  enqueueJob(store, 'extract', 'e2', extractPayload, 0)
  const ctx = fakeCtx({ services: { llm: { stream: () => textStream('{"candidates": [,]}') } } })
  await assert.rejects(
    runExtractJob(ctx, store, claim(store), extractPayload, new AbortController().signal),
    PipelineLlmError,
    'a malformed object is still a failure, not an empty answer',
  )
  registry.dispose()
  cleanup(root)
})

// ---- reconcile: batch decisions in one commit -----------------------------

const insertCandidate = (store, id, kind, title) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES (?, ?, 'repo-local', 'candidate', ?, 'body', 'human', 0, 0)`,
    )
    .run(id, kind, title)

const insertActive = (store, id, kind, title) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
       VALUES (?, ?, 'repo-local', 'active', ?, 'body', 'human', 0, 0)`,
    )
    .run(id, kind, title)

const reconcilePayload = (ids) => ({
  sessionId: 'sess-1',
  turn: 1,
  candidateIds: ids,
  provider: 'p',
  model: 'm',
  promptVersion: 1,
  payloadVersion: 1,
})

test('reconcile: activate/drop/supersede in ONE commit; fact superseded, procedure archived, preference kept', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    insertActive(store, 'old-fact', 'fact', 'old fact')
    insertActive(store, 'old-proc', 'procedure', 'old procedure')
    insertActive(store, 'old-pref', 'preference', 'old preference')
    insertCandidate(store, 'c0', 'fact', 'new fact')
    insertCandidate(store, 'c1', 'procedure', 'new procedure')
    insertCandidate(store, 'c2', 'preference', 'conflicting preference')
    insertCandidate(store, 'c3', 'fact', 'dup')
  })
  const reply = JSON.stringify({
    decisions: [
      { candidateIndex: 0, action: 'supersede', supersedes: 'old-fact' },
      { candidateIndex: 1, action: 'supersede', supersedes: 'old-proc' },
      { candidateIndex: 2, action: 'supersede', supersedes: 'old-pref' }, // must degrade: prefs keep both
      { candidateIndex: 3, action: 'drop' },
    ],
  })
  const ctx = fakeCtx({ services: { llm: { stream: () => textStream(reply) } } })
  const payload = reconcilePayload(['c0', 'c1', 'c2', 'c3'])
  enqueueJob(store, 'reconcile', 'r1', payload, 0)
  const job = claim(store)
  await runReconcileJob(ctx, store, job, payload, new AbortController().signal)

  const status = (id) => store.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(id).status
  assert.equal(status('c0'), 'active')
  assert.equal(status('old-fact'), 'superseded')
  assert.equal(
    store.db.prepare(`SELECT superseded_by FROM memories WHERE id = 'old-fact'`).get().superseded_by,
    'c0',
  )
  assert.equal(status('c1'), 'active')
  assert.equal(status('old-proc'), 'archived') // procedure versioning
  assert.equal(status('c2'), 'active')
  assert.equal(status('old-pref'), 'active') // both stay
  assert.equal(status('c3'), 'superseded') // drop
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'r1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
})

test('reconcile: vanished candidates (forgotten meanwhile) settle as an empty done', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const payload = reconcilePayload(['ghost'])
  enqueueJob(store, 'reconcile', 'r1', payload, 0)
  const job = claim(store)
  const ctx = fakeCtx({ services: { llm: { stream: () => { throw new Error('must not be called') } } } })
  await runReconcileJob(ctx, store, job, payload, new AbortController().signal)
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'r1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
})

test('reconcile: decisions must cover every candidate exactly once (else retry exit)', async () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => insertCandidate(store, 'c0', 'fact', 'x'))
  const payload = reconcilePayload(['c0'])
  enqueueJob(store, 'reconcile', 'r1', payload, 0)
  const job = claim(store)
  const ctx = fakeCtx({
    services: { llm: { stream: () => textStream(JSON.stringify({ decisions: [] })) } },
  })
  await assert.rejects(
    runReconcileJob(ctx, store, job, payload, new AbortController().signal),
    PipelineLlmError,
  )
  registry.dispose()
  cleanup(root)
})
