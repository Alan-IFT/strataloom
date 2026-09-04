/**
 * The L0 conversation substrate and Personal Memory (cross-repo scope).
 * These are the two capabilities added after the P0/P1 core: the durable
 * record of what was said, and memories that follow the user across repos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryService, MemoryInputError } from '../lib/service.js'
import { GLOBAL_STORE_KEY } from '../lib/store/store.js'
import { captureTurn, readTurn, pruneConversations } from '../lib/store/conversations.js'
import { collectTurnEvents, QUOTE_LABEL, QUOTE_SEQ } from '../lib/transcript.js'
import { runExtractJob } from '../lib/pipeline/extract.js'
import {
  buildContextProvider,
  countEntries,
  packetTokens,
  renderFramed,
  withinBudget,
  FRAMING_HEADER,
} from '../lib/recall/inject.js'
import { renderEntry, TRUNCATION_MARK } from '../lib/recall/render.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import {
  DONE_RETENTION_MS,
  EXTRACT_EVENT_EXCERPT_CHARS,
  GUIDANCE_BUDGET_TOKENS,
  INJECT_BODY_BUDGET_TOKENS,
  INJECT_PACKET_BUDGET_TOKENS,
  INJECT_TOP_N,
  L0_RETENTION_MS,
  RECALL_PACKET_BUDGET_TOKENS,
  ROLLUP_MAX_SCENARIOS,
  ROLLUP_SOURCE_LIMIT,
  ROLLUP_TARGET_CHARS,
  ROLLUP_TITLE_TARGET_CHARS,
  ROLLUP_TRANSCRIPT_CHARS,
  PERSONA_MAX_TOKENS,
  PERSONA_TARGET_CHARS,
  PERSONA_TITLE,
  SCENARIO_MAX_TOKENS,
  SOURCE_TURN_LIMIT,
  WORST_SOURCE_SEQS,
  worstPersonaTokens,
} from '../lib/constants.js'
import { collectMetrics } from '../lib/metrics.js'
import {
  GUIDANCE_SECTION,
  RECALL_NO_MATCH,
  SOURCE_NOT_SHOWN,
  registerTools,
} from '../lib/tools.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import {
  enqueueRebuildIfOverflowing,
  packetOverflows,
  readRevision,
  runRebuildJob,
} from '../lib/pipeline/rebuild.js'
import { estimateTokens } from '../lib/constants.js'
import { looksSecret, projectStore, PROJECTION_DIR, PROJECTION_FILE } from '../lib/projection.js'
import { enqueueJob, claimNextJob, cleanupJobs, commitClaimedJob } from '../lib/pipeline/jobs.js'
import { queryInjectableSet, queryInjectionRows } from '../lib/store/fts.js'
import {
  DERIVED_LAYERS,
  DERIVED_PROVENANCE,
  INJECTABLE_PROVENANCE,
  LAYER,
  MEMORY_STATUSES,
  PROVENANCES,
} from '../lib/types.js'
import {
  openRegistry,
  cleanup,
  tempRoot,
  fakeAgent,
  fakeCtx,
  turnEvents,
  userMessageEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
  assertHonestRefusal,
  assertNoFalseAdvice,
  DERIVED_SENTENCE,
  RAW_SENTENCE,
} from './helpers.mjs'

const makeRepo = () => {
  const dir = join(tempRoot(), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const setup = () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'p', cwd: repo })
  const ctx = fakeCtx({ agents: [principal] })
  const service = Reflect.construct(function () {}, [])
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = ctx
  service.stores = registry
  return { repo, root, registry, principal, ctx, service }
}

// ---------------------------------------------------------------- L0 ------

test('L0: a captured turn round-trips with per-event provenance', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = collectTurnEvents(
    turnEvents(3, [userMessageEvent('use pnpm here'), assistantMessageEvent(3, 'understood')]),
    3,
  )
  store.tx(() => captureTurn(store, 'sess-A', 3, events))

  const back = readTurn(store, 'sess-A', 3)
  assert.equal(back.length, 2)
  assert.deepEqual(
    back.map((row) => `${row.label}:${row.provenance}`),
    ['user:human', 'assistant:parent-agent'],
  )
  assert.match(back[0].text, /use pnpm here/)
  registry.dispose()
  cleanup(root)
})

test('L0: capture is idempotent by (session, seq)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const events = collectTurnEvents(turnEvents(1, [userMessageEvent('once')]), 1)
  store.tx(() => captureTurn(store, 'sess-A', 1, events))
  store.tx(() => captureTurn(store, 'sess-A', 1, events)) // replayed
  assert.equal(store.db.prepare(`SELECT count(*) c FROM conversations`).get().c, 1)
  registry.dispose()
  cleanup(root)
})

test('L0: pruning drops aged turns but never those a live memory cites', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const old = Date.now() - L0_RETENTION_MS - 86_400_000

  store.tx(() => {
    for (const [session, seq] of [['cited', 1], ['orphan', 1]]) {
      store.db
        .prepare(
          `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
           VALUES (?, ?, 1, 'user', 'human', 'old words', ?)`,
        )
        .run(session, seq, old)
    }
    // A live memory cites 'cited'; a tombstoned one cites 'orphan'.
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('m1','fact','repo-local','active','t','b','human',0,0),
                ('m2','fact','repo-local','tombstone','','','human',0,0)`,
      )
      .run()
    store.db
      .prepare(
        `INSERT INTO evidence (memory_id, kind, ref) VALUES ('m1','session','cited'),('m2','session','orphan')`,
      )
      .run()
  })

  pruneConversations(store, Date.now())
  const left = store.db
    .prepare(`SELECT DISTINCT session_id FROM conversations ORDER BY session_id`)
    .all()
    .map((r) => r.session_id)
  assert.deepEqual(left, ['cited'], 'a memory never outlives the words behind it')
  registry.dispose()
  cleanup(root)
})

/**
 * The exemption is per SESSION, not per cited row. A memory cites a session id
 * (`evidence.ref`), so every row of that session is held — including the rows
 * nothing quotes. Any attempt to narrow the exemption to the seqs actually
 * referenced turns this test red, which is the point: that narrowing would
 * delete the only complete copy of the surrounding words.
 */
test('L0: a cited session keeps EVERY row, including rows no memory references', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const old = Date.now() - L0_RETENTION_MS - 86_400_000

  store.tx(() => {
    const stmt = store.db.prepare(
      `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
       VALUES ('cited', ?, 1, 'user', 'human', ?, ?)`,
    )
    stmt.run(1, 'the quoted line', old)
    stmt.run(2, 'never quoted by anything', old)
    stmt.run(3, 'also never quoted', old)
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('m1','fact','repo-local','active','t','b','human',0,0)`,
      )
      .run()
    // The memory quotes seq 1 only; the exemption still covers 2 and 3.
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES ('m1','session','cited')`)
      .run()
  })

  pruneConversations(store, Date.now())
  const left = store.db
    .prepare(`SELECT seq FROM conversations WHERE session_id = 'cited' ORDER BY seq`)
    .all()
    .map((r) => r.seq)
  assert.deepEqual(left, [1, 2, 3], 'the exemption holds the whole session, not the cited seqs')
  registry.dispose()
  cleanup(root)
})

/**
 * The OTHER half of the predicate: `created_at < ?` is the only protection
 * keyed on how OLD a row is, and it is what keeps a turn alive across the
 * unavoidable window between `captureTurn` (unconditional, at the turn
 * boundary) and the evidence an extract job may or may not later write. A row
 * below `ENQUEUE_MIN_TURN_TOKENS`, or one whose extract found nothing worth
 * keeping, NEVER gets evidence — the age clause is all it has.
 *
 * Without this assertion the age clause carries zero coverage: forcing it true
 * (`created_at < ? OR 1=1`) or dropping it leaves every other test green while
 * the statement starts deleting live, unextracted conversation.
 */
test('L0: an unexpired, uncited row survives prune', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')

  // Captured just now, no evidence anywhere: the shape of a turn whose extract
  // has not run, was never enqueued, or produced no candidates.
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
         VALUES ('fresh', 1, 1, 'user', 'human', 'said five seconds ago', ?)`,
      )
      .run(Date.now())
  })

  pruneConversations(store, Date.now())
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM conversations WHERE session_id = 'fresh'`).get().c,
    1,
    'age is the only thing protecting a turn that has not been extracted yet',
  )
  registry.dispose()
  cleanup(root)
})

/** One scripted LLM reply, shaped like the stream `llm-call.ts` consumes. */
const textStream = (text) => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

/**
 * Build a memory whose evidence row carries a REAL excerpt, by running the
 * real extract job against real captured L0.
 *
 * Every byte here travels the production writer — `collectTurnEvents` ->
 * `captureTurn` -> `runExtractJob` -> the `INSERT INTO evidence` inside it.
 * A hand-written `INSERT INTO evidence (…, excerpt) VALUES (…)` was the
 * obvious shortcut and is refused on purpose: ADR 0009 lesson 7 records what
 * it costs. A change that violated D5 turned only 1 of 171 tests red precisely
 * because the semantic tests played writer themselves, so they asserted what
 * their author believed the writer did rather than what it does. A test for
 * "`source` returns what the extractor stored" is worthless if the test is
 * the thing that stored it.
 * @param sessionId - the session the memory will cite.
 * @param entries - raw session events for turn 1.
 * @param sourceSeqs - the seqs the scripted model cites.
 * @returns the store, the memory id, and the excerpt bytes as stored.
 */
const memoryWithExcerpt = async (service, principal, sessionId, entries, sourceSeqs) => {
  const store = service.storeFor(principal, true)
  store.tx(() => captureTurn(store, sessionId, 1, collectTurnEvents(turnEvents(1, entries), 1)))
  const payload = {
    sessionId,
    turn: 1,
    provider: 'p',
    model: 'm',
    promptVersion: 1,
    payloadVersion: 1,
  }
  enqueueJob(store, 'extract', `e-${sessionId}`, payload, 0)
  const reply = JSON.stringify({
    candidates: [{ title: 'cited memory', body: 'cited body', kind: 'fact', sourceSeqs }],
  })
  const ctx = fakeCtx({ services: { llm: { stream: () => textStream(reply) } } })
  const now = Date.now()
  await runExtractJob(
    ctx,
    store,
    claimNextJob(store, now, now + 60_000),
    payload,
    new AbortController().signal,
  )
  const row = store.db
    .prepare(`SELECT memory_id, excerpt FROM evidence WHERE ref = ?`)
    .get(sessionId)
  return { store, id: row.memory_id, excerpt: row.excerpt }
}

test('L0 drill-down: sourceOf returns the CITED QUOTE, not the tail of the session', async () => {
  // The defect this locks (ADR 0009): `source` used to read the session's last
  // `SOURCE_TURN_LIMIT` rows, while cited lines sit anywhere in the session
  // (measured p25=0.24 / p50=0.57 / p75=0.80). Only 9.3% of cited passages
  // landed in that window and 6-8% survived the render budget, so a tool that
  // promises 核对原话 answered with late-session context instead.
  //
  // The fixture reproduces exactly that geometry: the cited line is FIRST and
  // is then buried under far more than any window holds. A tail read cannot
  // reach it; reading the stored excerpt cannot miss it.
  const { root, registry, principal, service } = setup()
  const entries = [userMessageEvent('the cited sentence: we deploy with make deploy')]
  for (let i = 0; i < SOURCE_TURN_LIMIT * 2; i++) {
    entries.push(assistantMessageEvent(1, `later unrelated chatter number ${i}`))
  }
  const { id, excerpt } = await memoryWithExcerpt(service, principal, 'sess-quote', entries, [2])

  const turns = await service.source(id, principal, SOURCE_TURN_LIMIT)
  assert.equal(turns.length, 1, 'the quotation is ONE hit, whole and unsplit')
  assert.match(
    turns[0].text,
    /the cited sentence/,
    'the passage the extractor actually cited must reach the caller, however deep it is buried',
  )
  // The bytes are the stored bytes, unmodified. `deepEqual` on the string
  // rather than a regex: "returned verbatim" is the promise.
  assert.equal(turns[0].text, excerpt, 'the excerpt is returned byte-for-byte')
  registry.dispose()
  cleanup(root)
})

test('sourceOf marks a quote as a quote, and conversation as conversation', async () => {
  // ADR 0009 §5.3: an auditor must be able to tell "this is the passage the
  // memory quotes" from "this is a slice of the surrounding conversation".
  // Returning both as one undifferentiated batch of hits lets context be read
  // as evidence, which is the confusion D3 exists to prevent. The fallback is
  // not rare — 80 of 403 real evidence rows (19.9%) have no excerpt — so both
  // shapes are live and both must name themselves.
  const { root, registry, principal, service } = setup()

  // (1) quote path — real extract writer, so a real excerpt exists.
  const quoted = await memoryWithExcerpt(
    service,
    principal,
    'sess-marked',
    [userMessageEvent('the quoted words themselves')],
    [2],
  )
  const quoteTurns = await service.source(quoted.id, principal, SOURCE_TURN_LIMIT)
  assert.equal(quoteTurns.length, 1)
  assert.equal(quoteTurns[0].label, QUOTE_LABEL, 'the quote says it is a quote')
  assert.equal(quoteTurns[0].seq, QUOTE_SEQ, 'and carries no line number it does not have')

  // (2) fallback path — `propose` writes evidence with no excerpt (real
  // writer, real gap: propose runs mid-turn, so the L0 rows do not exist yet).
  const store = service.storeFor(principal, false)
  const { id: proposedId } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  assert.equal(
    store.db.prepare(`SELECT excerpt FROM evidence WHERE memory_id = ?`).get(proposedId).excerpt,
    null,
    'the fixture must reach the fallback for the reason production does: no excerpt',
  )
  store.tx(() =>
    captureTurn(
      store,
      principal.session.id,
      1,
      collectTurnEvents(turnEvents(1, [userMessageEvent('we deploy with make deploy')]), 1),
    ),
  )
  const fallbackTurns = await service.source(proposedId, principal, SOURCE_TURN_LIMIT)
  assert.ok(fallbackTurns.length > 0)
  for (const row of fallbackTurns) {
    assert.notEqual(row.label, QUOTE_LABEL, 'conversation must never masquerade as a quotation')
    assert.ok(row.seq >= 0, 'a captured line keeps its real seq')
  }

  // The distinction stated as the property that matters: the two paths are
  // TELLABLE APART by a reader holding only the returned rows.
  assert.notEqual(
    quoteTurns[0].label,
    fallbackTurns[0].label,
    'an auditor can separate evidence from context using only what was returned',
  )
  registry.dispose()
  cleanup(root)
})

test('sourceOf never splits an excerpt, even one containing the separator', async () => {
  // The forbidden shortcut, locked out. `extract.ts` joins cited segments with
  // `\n---\n` and states at length that this is human audit material and NOT a
  // machine-parseable format, because an event's own text can WRITE that
  // sequence — measured, 25 of 778 real segments (3.21%) are already ambiguous.
  // Splitting on it inside a fix meant to honour D3 would manufacture exactly
  // the misattribution the comment warns about, so the excerpt is returned as
  // one opaque blob.
  //
  // The fixture makes a HOSTILE case: the user's own message contains the
  // separator. A consumer that splits sees a segment with no `[label]` and
  // attributes it to nobody, or to the wrong source.
  const { root, registry, principal, service } = setup()
  const evil = 'first part\n---\nsecond part that no splitter may attribute'
  const { id, excerpt } = await memoryWithExcerpt(
    service,
    principal,
    'sess-evil',
    [userMessageEvent(evil)],
    [2],
  )
  assert.ok(excerpt.includes('\n---\n'), 'the fixture really does contain the separator')

  const turns = await service.source(id, principal, SOURCE_TURN_LIMIT)
  assert.equal(turns.length, 1, 'a separator inside the text must not become a second hit')
  assert.equal(turns[0].text, excerpt, 'the excerpt is passed through byte-for-byte')
  assert.ok(turns[0].text.includes(evil), 'including the caller`s own separator, unescaped')
  registry.dispose()
  cleanup(root)
})

test('L0 drill-down FALLBACK: sourceOf returns the conversation when no quote was stored', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  const store = service.storeFor(principal, false)
  const events = collectTurnEvents(turnEvents(1, [userMessageEvent('we deploy with make deploy')]), 1)
  store.tx(() => captureTurn(store, principal.session.id, 1, events))

  const turns = await service.source(id, principal, 20)
  assert.equal(turns.length, 1)
  assert.match(turns[0].text, /make deploy/)
  assert.equal(turns[0].provenance, 'human')

  await assert.rejects(service.source('ghost', principal, 20), /no memory with id/)
  registry.dispose()
  cleanup(root)
})

/**
 * A turn with more material than any window holds, shaped the way real
 * sessions are: assistant reasoning interleaved with the calls it made and the
 * results they returned.
 */
const denseTurnEntries = (rounds) => {
  const entries = []
  for (let i = 0; i < rounds; i++) {
    entries.push(toolCallEvent(1, `c${i}`, 'bash', JSON.stringify({ command: `step ${i}` })))
    entries.push(assistantMessageEvent(1, `assistant reasoning number ${i}`))
    entries.push(toolResultEvent(1, `c${i}`, `result ${i}`))
  }
  return entries
}

/**
 * The row-density rule below now applies to ONE of `source`'s two paths, so it
 * is asserted as two tests instead of one.
 *
 * The single test it replaces would have stayed green through the change while
 * quietly stopping to guard what it claimed. Its fixture used `propose`, whose
 * evidence has no excerpt, so it silently became a fallback-only test — the
 * `SOURCE_TURN_LIMIT` rule it names no longer governs the path most reads take,
 * and nothing on screen would have said so. Splitting it states which path each
 * rule belongs to, and adds the assertion the row rule cannot make: that the
 * quote path is NOT row-budgeted at all.
 */
test('the L0 drill-down FALLBACK window survives the tool/call row-density change', async () => {
  // The read-side cost that nearly shipped unrecorded. `SOURCE_TURN_LIMIT` is a
  // ROW budget over a table whose density rose ~68% when `tool/call` capture
  // landed, so the same 20 rows bought a third less conversation — measured on
  // real sessions: -34.3% window characters, -34.6% assistant rows.
  //
  // `extract` did not have this problem because its budget is in CHARACTERS and
  // re-balanced itself. That is the general lesson worth pinning: a change in
  // what L0 stores must be re-checked against EVERY consumer's own ruler, and
  // the row-budgeted one cannot self-correct.
  //
  // The assertion is the RULE, not the constant: the window must still deliver
  // as much genuine CONVERSATION as it did before tool calls joined the table.
  // `PRE_CHANGE_LIMIT` is the old value, and it is the yardstick precisely
  // because back then every row in the window was conversation.
  const PRE_CHANGE_LIMIT = 20
  const { root, registry, principal, service } = setup()
  // `propose` is what puts this on the fallback path — it writes evidence with
  // no excerpt — and the test now SAYS so rather than depending on it silently.
  const { id } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  const store = service.storeFor(principal, false)
  assert.equal(
    store.db.prepare(`SELECT excerpt FROM evidence WHERE memory_id = ?`).get(id).excerpt,
    null,
    'this test governs the no-excerpt path; if this row ever gains one it is testing nothing',
  )

  const events = collectTurnEvents(turnEvents(1, denseTurnEntries(PRE_CHANGE_LIMIT * 3)), 1)
  store.tx(() => captureTurn(store, principal.session.id, 1, events))

  const window = await service.source(id, principal, SOURCE_TURN_LIMIT)
  const conversationRows = window.filter((row) => !row.label.startsWith('tool-call:'))
  assert.ok(
    conversationRows.length >= PRE_CHANGE_LIMIT,
    `the window delivers ${conversationRows.length} conversation rows, fewer than the ` +
      `${PRE_CHANGE_LIMIT} it delivered before tool calls shared it — SOURCE_TURN_LIMIT ` +
      `(${SOURCE_TURN_LIMIT}) must track L0 row density`,
  )
  // The calls are IN the window rather than filtered out of it — the rejected
  // alternative would have kept the limit at 20 by hiding what the agent did,
  // which is the blindness this whole change removes.
  assert.ok(
    window.some((row) => row.label.startsWith('tool-call:')),
    'the drill-down shows the request, not only the result',
  )
  registry.dispose()
  cleanup(root)
})

test('the QUOTE path ignores SOURCE_TURN_LIMIT (it is still token-budgeted)', async () => {
  // RENAMED. This was "the QUOTE path is not row-budgeted", which read as "no
  // budget constrains it" — and that is false in a way that mattered: the
  // render TOKEN budget constrains it very much, and an excerpt over that
  // budget used to be dropped whole and reported as `RECALL_NO_MATCH`. The
  // name is now the exact claim: this test governs `SOURCE_TURN_LIMIT` and
  // NOTHING else. The token budget is governed at the tool layer, by
  // 'sourceOf delivers a LONG excerpt through the real render' below.
  //
  // The complement of the test above, and the reason the split was necessary.
  // `SOURCE_TURN_LIMIT` governs a window over L0 rows; a stored quotation is
  // not a window over anything, so density cannot erode it and the row limit
  // must not apply. The same dense turn that forces the fallback to spend its
  // whole budget yields exactly one hit here.
  const { root, registry, principal, service } = setup()
  const entries = denseTurnEntries(20)
  entries.push(userMessageEvent('the decisive sentence, cited by the model'))
  const citedSeq = turnEvents(1, entries).find(
    (event) => event.type === 'user/message',
  ).seq
  const { id, excerpt } = await memoryWithExcerpt(
    service,
    principal,
    'sess-dense',
    entries,
    [citedSeq],
  )

  const turns = await service.source(id, principal, SOURCE_TURN_LIMIT)
  assert.equal(turns.length, 1, 'a quotation is one hit, not a windowful of rows')
  assert.equal(turns[0].label, QUOTE_LABEL)
  assert.equal(turns[0].text, excerpt, 'delivered whole — no row budget was spent on it')
  assert.match(turns[0].text, /the decisive sentence/)
  registry.dispose()
  cleanup(root)
})

/**
 * Drive the REAL `memory_recall` tool — execute plus the output renderer — and
 * return both the structured value and the exact text a model would receive.
 *
 * The renderer is the point. Three separate mutation experiments survived the
 * whole suite before this existed (silently truncating the excerpt in
 * `service.source`; hard-coding the hit's `kind` to `'fact'`; and the budget
 * cliff itself), because no test carried a quotation through `renderFramed` to
 * the bytes that actually reach the model. Asserting on `service.source`'s
 * return value alone cannot see any of them: it stops one layer above where
 * the damage happens.
 */
const realRecallTool = (ctx, memory) => {
  let captured
  registerTools({ ...ctx, tools: { register: (tool) => {
    if (tool.name === 'memory_recall') captured = tool
  } } }, memory)
  assert.ok(captured, 'memory_recall must be registered')
  return async (args, agent) => {
    const value = await captured.execute(args, { agent })
    const text = captured.output.render(args, value).map((block) => block.text).join('')
    return { value, text }
  }
}

test('sourceOf delivers a LONG excerpt through the real render, marked, never as "no match"', async () => {
  // THE regression for the render-budget cliff, and the one test that runs the
  // whole path: real writer -> real `service.source` -> real tool execute ->
  // real `renderFramed`, at the real budget.
  //
  // The defect: `renderEntry` indents every `\n` by two spaces, so a stored
  // excerpt renders at up to 3x its stored length. The quotation path returns
  // exactly ONE hit, so when that hit priced over `RECALL_PACKET_BUDGET_TOKENS`
  // `withinBudget` skipped it, `renderFramed` returned '', and `tools.ts`
  // substituted `RECALL_NO_MATCH` — telling the model "No stored memories
  // matched." about a memory it had just found and read. Measured with the
  // real renderer: 4165 stored chars -> 8236 rendered -> 2059 tokens against a
  // 1820 budget -> 0 characters delivered.
  //
  // The fixture is built from the WRITER's own constants, so it is a shape the
  // writer can really produce rather than a number copied here: newline-dense
  // text (deep-indented YAML and line-per-value tool output are its everyday
  // forms) at the per-event cap, cited `WORST_SOURCE_SEQS` times.
  const { root, registry, principal, ctx, service } = setup()
  const lines = Array.from({ length: EXTRACT_EVENT_EXCERPT_CHARS / 2 }, (_, i) => `${i % 10}`)
  const entries = Array.from({ length: WORST_SOURCE_SEQS }, () =>
    userMessageEvent(`the cited passage\n${lines.join('\n')}`),
  )
  const citedSeqs = turnEvents(1, entries)
    .filter((event) => event.type === 'user/message')
    .map((event) => event.seq)
  const { id, excerpt } = await memoryWithExcerpt(
    service,
    principal,
    'sess-long',
    entries,
    citedSeqs,
  )
  // The fixture must actually exceed the budget, or this test proves nothing.
  // Asserted rather than assumed: every excerpt in every other fixture is
  // under 64 characters, which is exactly why the length dimension — the
  // dimension the defect lives in — went uncovered.
  const renderedTokens = estimateTokens(
    renderEntry({ id: `seq ${QUOTE_SEQ}`, kind: QUOTE_LABEL, title: 'human', body: excerpt }, true),
  )
  assert.ok(
    renderedTokens > RECALL_PACKET_BUDGET_TOKENS,
    `the fixture renders at ${renderedTokens} tokens, inside the ${RECALL_PACKET_BUDGET_TOKENS} ` +
      'budget — it no longer reproduces the cliff and must be made denser',
  )

  const recall = realRecallTool(ctx, service)
  const { value, text } = await recall({ sourceOf: id }, principal)

  // 1. The cliff itself: the model is NOT told the memory does not exist.
  assert.notEqual(text, RECALL_NO_MATCH, 'an existing, readable memory is never "no match"')
  assert.doesNotMatch(text, /No stored memories matched/)
  // 2. Something real arrives, and it is the cited words.
  assert.ok(text.length > 0, 'the drill-down delivers a packet, not the empty string')
  assert.match(text, /the cited passage/, 'the passage the extractor cited reaches the model')
  // 3. Incomplete delivery SAYS it is incomplete — a cut quotation presented as
  //    a whole one would be a worse audit failure than the empty packet was.
  assert.ok(text.includes(TRUNCATION_MARK), 'the truncation is visible, not silent')
  assert.ok(TRUNCATION_MARK !== '', 'an empty mark would make the assertion above vacuous')
  // 4. It fits the budget it was cut to fit.
  assert.ok(
    estimateTokens(text) <= RECALL_PACKET_BUDGET_TOKENS + estimateTokens(FRAMING_HEADER) + 2,
    'the cut packet is inside the budget that forced the cut',
  )
  // 5. BLIND SPOT 2: the quote/context distinction survives to the rendered
  //    text. Hard-coding `kind: turn.label` to `'fact'` in `tools.ts` left all
  //    216 tests green; §5.3's promise that an auditor can tell a quotation
  //    from surrounding conversation had no guard at the layer that delivers it.
  assert.equal(value.hits[0].kind, QUOTE_LABEL, 'the hit names itself a quotation')
  assert.match(text, /^- \[quote\] /m, 'and the RENDERED bullet says so too')
  assert.equal(value.hits[0].id, `seq ${QUOTE_SEQ}`, 'at an id no L0 line can hold')
  registry.dispose()
  cleanup(root)
})

test('sourceOf never silently shortens a quotation that fits', async () => {
  // BLIND SPOT 1. Adding `cited.excerpt.slice(0, 200)` to the quotation branch
  // of `service.source` left all 216 tests green: every fixture excerpt was
  // under 64 characters, and `assert.equal(turns[0].text, excerpt)` compares
  // the function's output against the value that same function read — it
  // cannot see a truncation that happens before both.
  //
  // So this asserts LENGTH against the writer's own output, with an excerpt
  // comfortably past any plausible silent cut but inside the render budget:
  // what arrives at the model must contain the END of the quotation, not just
  // its head.
  const { root, registry, principal, ctx, service } = setup()
  // Sized against the WRITER's own per-segment cap, not a number picked here:
  // `capEventText` cuts each cited event at `EXTRACT_EVENT_EXCERPT_CHARS`, so a
  // longer fixture would lose its tail to a legitimate, marked truncation and
  // this test would be asserting the writer's cap rather than the read path's
  // fidelity. Just under the cap is the longest excerpt that must arrive whole.
  const tail = 'CLOSING-MARKER'
  const head = 'OPENING-MARKER '
  const filler = 'the middle of the quotation, '.repeat(
    Math.floor((EXTRACT_EVENT_EXCERPT_CHARS - head.length - tail.length - 10) / 29),
  )
  const entries = [userMessageEvent(`${head}${filler}${tail}`)]
  const citedSeq = turnEvents(1, entries).find((e) => e.type === 'user/message').seq
  const { id, excerpt } = await memoryWithExcerpt(service, principal, 'sess-mid', entries, [
    citedSeq,
  ])
  // Far past any plausible silent `slice()`, and — critically — past the 64
  // characters every other fixture stops at, which is why this dimension was
  // uncovered. Also verified UNCUT by the writer, so a missing tail below can
  // only be the read path's doing.
  assert.ok(excerpt.length > 300, `the writer stored ${excerpt.length} chars; too short to test`)
  assert.ok(!excerpt.endsWith('…'), 'the writer stored this whole; it did not cap it')

  const { value, text } = await realRecallTool(ctx, service)({ sourceOf: id }, principal)
  // The whole excerpt fits this budget, so nothing may be cut at all.
  assert.equal(value.hits[0].body, excerpt, 'the stored bytes arrive whole')
  assert.ok(!text.includes(TRUNCATION_MARK), 'an excerpt that fits is not marked as cut')
  // Both ENDS must be present. Head-only assertions are what a `slice()` passes.
  assert.match(text, /OPENING-MARKER/)
  assert.match(text, /CLOSING-MARKER/, 'the TAIL of the quotation survives to the model')
  registry.dispose()
  cleanup(root)
})

test('an unshowable sourceOf reports the SOURCE as missing, never the memory', async () => {
  // D-1b. `tools.ts` shared `RECALL_NO_MATCH` between both modes. In query mode
  // it is right; in `sourceOf` mode it is ALWAYS false, because reaching the
  // renderer means the memory was found, authorised and read.
  //
  // It also polluted a decision input: `metrics.ts` counts that exact string in
  // L0 to compute the recall miss rate that ADR 0005 uses to decide whether
  // retrieval needs embeddings. A drill-down showing nothing is not a failed
  // SEARCH, and counting it as one biases that number.
  const { root, registry, principal, ctx, service } = setup()
  // `propose` writes evidence with no excerpt and captures no turn, so neither
  // path can show anything — the real shape of "the source cannot be shown".
  const { id } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  const { value, text } = await realRecallTool(ctx, service)({ sourceOf: id }, principal)
  assert.equal(value.hits.length, 0, 'nothing could be shown')
  assert.equal(text, SOURCE_NOT_SHOWN)
  assert.notEqual(text, RECALL_NO_MATCH, 'the memory exists; saying otherwise is a lie')
  assert.doesNotMatch(
    text,
    /No stored memories matched/,
    'and the miss-rate metric must not count this drill-down as a search miss',
  )
  // The two causes are distinguished for the reader: evidence too large to
  // render is not the same event as a conversation that cannot be reached.
  assert.match(text, /too large|not readable/)

  // The query mode is UNCHANGED — the shared constant keeps its meaning and
  // its bytes, so the historical miss-rate series stays comparable.
  const miss = await realRecallTool(ctx, service)({ query: 'nothing matches this' }, principal)
  assert.equal(miss.text, RECALL_NO_MATCH, 'a real search miss still reads as one')
  registry.dispose()
  cleanup(root)
})

// ------------------------- sourceOf: a live row is never told it does not exist --

/**
 * A live row's id must never be answered with "no memory with id …".
 *
 * WHAT WAS WRONG. `service.source()` INNER-JOINed `evidence` to `memories` and
 * ended with `no memory with id <id>, or it was forgotten`. Reaching that line
 * meant only "no session evidence row was found", so a row that is PRESENT,
 * ACTIVE, and whose id `recall` had just handed to the caller was told it does
 * not exist. Measured on the unmodified tree, all four of these were denied:
 *
 * ```
 * A raw   + evidence      : RETURNED 1 turn(s)
 * B raw   + NO evidence   : THREW ... no memory with id B-raw-noev, or it was forgotten
 * C L1/L2/L3 + evidence   : RETURNED 1 turn(s)      <- derived rows WITH evidence answer fine
 * D L1/L2/L3 + NO evidence: THREW ... no memory with id D-derived-N, or it was forgotten
 * ```
 *
 * CELL C IS THE WHOLE POINT: `derived` is NOT the discriminant. A derived row
 * with an evidence row answers normally, and cell B shows a RAW row reaches the
 * same denial. The discriminant is the ABSENCE OF A SESSION EVIDENCE ROW, so
 * these cases are keyed on EXISTENCE, not on derivedness — and there are FOUR
 * execution points, not three.
 *
 * WHY THIS SURFACE THROWS RATHER THAN RENDERING `SOURCE_NOT_SHOWN`: that
 * sentence asserts a four-cause disjunction, and for a row with no source every
 * disjunct is false. Trading a false denial for a false CAUSE is ADR 0012
 * lesson 6. The case it was written for is unchanged and still pinned below.
 */

/**
 * Plant an active derived row of a GIVEN layer in a store.
 *
 * `layer` is REQUIRED and has NO DEFAULT (todo-l precedent, and the same
 * helper contract `test/group.test.mjs` uses). A default would let a call site
 * stay silent about the layer and quietly re-concentrate the suite on one
 * value — v0.4.15 and v0.4.16 both shipped that costume of the same failure.
 *
 * ORDERING IS LOAD-BEARING: D9's triggers retire the ENTIRE derived layer on
 * any raw insert/update/delete, so every raw write must already have happened.
 * A fixture that plants the derived row first holds nothing by the time the
 * assertion runs and passes for the wrong reason.
 */
const plantDerivedRow = (store, id, layer) => {
  assert.ok(
    DERIVED_LAYERS.includes(layer),
    `plantDerivedRow needs an explicit derived layer, got ${layer}`,
  )
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', ?, 'active', 'generated rollup', 'generated', ?, 0, 9000000000000, ?)`,
    )
    .run(id, store.kind === 'global' ? 'private' : 'repo-local', DERIVED_PROVENANCE, layer)
  return id
}

/**
 * Sampled at the moment of the `source` call, not at insert time — D9 may have
 * deleted the row in between, and a fixture that no longer holds what it says
 * it holds proves nothing.
 *
 * The layer is checked EXACTLY. `notEqual(row.derived, LAYER.RAW)` collapses
 * all three derived layers into one value: it cannot tell an L1 fixture from an
 * L3 one, so against the layer-coverage gap these cases exist for it asserts
 * nothing at all.
 */
const assertLiveRowAt = (store, id, layer) => {
  const row = store.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
  assert.ok(row, `the row ${id} must still be in the store when source() runs`)
  assert.equal(row.status, 'active', 'and live — a tombstone would take the D5 path instead')
  assert.equal(
    row.derived,
    layer,
    `and sitting on layer ${layer} exactly — a case that plants one layer while asserting ` +
      'only "not RAW" cannot detect a production check that covers a different layer',
  )
  const evidence = store.db
    .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
    .get(id)
  assert.equal(
    evidence.n,
    0,
    'the precondition of this whole family is that the row has NO session evidence; with one ' +
      'it answers normally (cell C) and the case would be testing the success path',
  )
}

/**
 * Capture the refusal and CLASSIFY it. `assert.rejects(p, MemoryInputError)`
 * cannot do this: the fail-closed `no memory with id …` is ALSO a
 * MemoryInputError, so that form cannot tell whether the new branch ran at all
 * — v0.4.16 shipped a vacuous test on exactly this shape.
 */
const captureSourceRefusal = async (service, id, agent) => {
  let message
  await assert.rejects(service.source(id, agent, SOURCE_TURN_LIMIT), (error) => {
    assert.ok(error instanceof MemoryInputError, 'the refusal keeps its class')
    message = error.message
    return true
  })
  return message
}

const LAYER_NAMES = {
  [LAYER.SUMMARY]: 'L1 rollup',
  [LAYER.SCENARIO]: 'L2 scenario',
  [LAYER.PERSONA]: 'L3 portrait',
}

/**
 * ⬆️ `assertHonestRefusal`, `assertNoFalseAdvice`, `DERIVED_SENTENCE` and
 * `RAW_SENTENCE` NOW LIVE IN `./helpers.mjs` AND ARE IMPORTED AT THE TOP OF
 * THIS FILE.
 *
 * ⛔ WHY THEY MOVED (rework, step 3c). Defining them here guarded the two
 * `service.ts` sentences and nothing else. Two consequences, both measured:
 *   - `group.test.mjs`'s 6h cases could not import them and had
 *     RE-IMPLEMENTED NINE of these assertions inline, plus a hardcoded copy of
 *     the derived sentence — exactly the drift a shared helper exists to
 *     prevent, and a copy that a wording rework leaves silently stale.
 *   - The three MODEL-FACING DESCRIPTION STRINGS this round edited had no
 *     guard at all. Three mutations, each proven landed in `lib/`, ALL
 *     survived at 298/298/0: MK (`sourceOf` param description -> `Forget it
 *     and recall it again to fix this.`), MM (tool description + the literal
 *     v0.4.16 payload `Start a session inside that checkout and retry.`), and
 *     MN (`GUIDANCE_SECTION` + `If none, forget it.`, priced at 157 <= 160 so
 *     the load-time budget assertion does not catch it, and paid on EVERY
 *     request).
 *
 * That is the SIXTH occurrence of "one rule, N execution points, only some
 * guarded" — this time the slice was *service sentences vs. tool-description
 * sentences*. A helper living in one slice's test file is a helper the other
 * slice does not import, so it now lives beside `fakeAgent` in `helpers.mjs`,
 * which both files already import. The full rationale is on the definitions
 * there; T8 below runs `assertNoFalseAdvice` over all three descriptions.
 */

/**
 * T1-T3: one INDEPENDENT test per derived layer, generated by this loop.
 *
 * WHY THREE TESTS AND NOT ONE TEST WITH AN INTERNAL LOOP. Measured, not
 * stylistic (v0.4.15): a single case looping over the layers stops at its first
 * failing assertion, so it reports "layer 1 failed" and says NOTHING about
 * layer 3 — whether the third layer also leaks is unobservable from the result.
 * Generating a test per layer makes each layer its own execution point, and a
 * mutant that misses exactly one layer names that layer in the output.
 */
for (const layer of DERIVED_LAYERS) {
  test(`sourceOf on an ${LAYER_NAMES[layer]} says what the row IS, never that it does not exist`, async () => {
    const { root, registry, principal, service } = setup()
    const store = service.storeFor(principal, true)
    // EVERY raw write first (D9), then the derived plant. Reversed, the raw
    // propose below would delete the layer and the assertion would be made
    // against an absent row — passing through the fail-closed path.
    await service.propose(
      { title: 'raw anchor', body: 'a real memory, written before the plant', kind: 'fact' },
      principal,
    )
    const id = plantDerivedRow(store, `rollup-${layer}`, layer)

    assertLiveRowAt(store, id, layer)

    const message = await captureSourceRefusal(service, id, principal)
    // Every guard BOTH sentences carry — see `assertHonestRefusal`, which the
    // raw case calls with the same force. The layer-specific facts follow.
    assertHonestRefusal(message, id, DERIVED_SENTENCE(id))
    // What it IS: a generated summary, which is a KIND OF ROW, not a recording
    // that failed to happen.
    assert.match(message, /generated summary/)
    assert.match(message, /not a memory recorded from a conversation/)
    // ⛔ REWORK (step 3c): the derived sentence used to end `…so it has no
    // source passage of its own.`, and that clause is FALSE for a derived row
    // whose only evidence is `commit`/`file`/`url` — `evidence.excerpt` there
    // holds a real passage. T4d below measures all nine such cells; this pin
    // stops the overclaim returning through the layer cases too. It is the
    // SAME forbidden regex T4b applies to the raw sentence, which is how the
    // defect was found: the suite already owned a regex convicting its own
    // shipped sentence, applied to one branch only.
    assert.doesNotMatch(
      message,
      /no source passage was recorded|nothing was recorded|has no source passage/i,
      'the derived sentence may not claim nothing was recorded — a derived row can carry ' +
        'commit/file/url evidence whose excerpt is a real passage',
    )
    // And NOT the raw answer: an L1/L2/L3 row is not "a stored memory whose
    // source conversation went unrecorded", it is a row that never had one.
    assert.doesNotMatch(message, /is a stored memory, but no source conversation was recorded/)

    // The row is untouched: this is a read path that refuses, not a writer.
    assertLiveRowAt(store, id, layer)
    registry.dispose()
    cleanup(root)
  })
}

test('sourceOf on a RAW row with no session evidence says so, and does not deny it exists', async () => {
  // T4 — EXECUTION POINT 1, the one the original framing missed entirely by
  // keying the fix on `derived`. "Unreachable today" is explicitly NOT a
  // defence in this repo (the "todo p" precedent), and the reachability is thin
  // anyway: nothing in the schema requires a raw row to carry evidence, and
  // `propose` is not the only writer.
  //
  // Measured under the narrower derived-only fix, this input still emitted
  // `no memory with id raw-noev, or it was forgotten` — mutation M5 below.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  const { id } = await service.propose(
    { title: 'a raw memory', body: 'written by the real writer, evidence and all', kind: 'fact' },
    principal,
  )
  // Strip the evidence rather than hand-writing a memory row without one: the
  // row is then exactly what the real writer produces, minus the one thing
  // under test. Deleting from `evidence` is not a `memories` write, so D9 does
  // not fire and nothing else in the fixture moves.
  store.db.prepare(`DELETE FROM evidence WHERE memory_id = ?`).run(id)

  const row = store.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
  assert.equal(row.status, 'active', 'the row is live when source() runs')
  assert.equal(row.derived, LAYER.RAW, 'and RAW exactly — this is the raw execution point')
  assert.equal(
    store.db.prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ?`).get(id).n,
    0,
    'and carries no evidence at all — the precondition this case exists for (P3 removes this ' +
      'deletion and the case must go red)',
  )

  const message = await captureSourceRefusal(service, id, principal)
  // ⛔ REWORK: this line used to be the ONLY positive assertion here, and the
  // derived sentence's five negatives were not applied to it. Both sentences
  // now run the SAME guards, from one definition.
  assertHonestRefusal(message, id, RAW_SENTENCE(id))
  assert.match(message, /no source conversation was recorded/)
  // It must NOT call a raw row a generated summary: that is the derived
  // sentence, and it is false here. Sharing one sentence across both would be
  // the v0.4.16 defect in miniature.
  assert.doesNotMatch(
    message,
    /generated summary/,
    'a raw memory is not a generated summary; the two answers are different facts',
  )

  // AND THROUGH THE TOOL LAYER, not just `service.source()`'s exit. ADR 0012
  // §5's whole finding is that stopping at the service exit is what let three
  // mutations survive the suite: the damage happens AFTER it. The derived case
  // reaches the outermost ruler via T6; without this, the RAW sentence's only
  // measurement was one layer short of where the model reads it.
  let thrown
  await assert.rejects(realRecallTool(ctx, service)({ sourceOf: id }, principal), (error) => {
    thrown = error
    return true
  })
  assert.ok(thrown instanceof MemoryInputError, 'a deliberate answer passes through untouched')
  assert.doesNotMatch(thrown.message, /store is unavailable/)
  assert.notEqual(thrown.message, RECALL_NO_MATCH)
  assert.notEqual(thrown.message, SOURCE_NOT_SHOWN, 'and it is not the four-cause disjunction')
  // The bytes the model actually receives carry every guard, unchanged.
  assertHonestRefusal(thrown.message, id, RAW_SENTENCE(id))
  registry.dispose()
  cleanup(root)
})

/**
 * T4b — one INDEPENDENT test per NON-SESSION `evidence.kind`.
 *
 * ⛔ WHY THIS EXISTS (rework, step 3b). `evidence.kind` is a four-value enum
 * (`CHECK (kind IN ('session','commit','file','url'))`, schema.ts), and
 * `source()`'s join reads exactly one of them. A row whose ONLY evidence is
 * `commit`/`file`/`url` is therefore null-extended and takes the raw branch —
 * while `evidence.excerpt` on that very row may hold a real recorded passage.
 * Measured against the build under review:
 *
 * ```
 * only-commit: THREW <id> is a stored memory, but no source passage was recorded for it, …
 *    ^ evidence.kind=commit excerpt="THE REAL RECORDED PASSAGE" IS recorded
 * only-file / only-url : identical
 * ```
 *
 * The sentence asserted a fact the store CONTRADICTS. On HEAD this input got
 * the generic denial — wrong, but only a false DENIAL; the reviewed wording
 * turned it into a false STATEMENT OF FACT, which is ADR 0012 lesson 6, the
 * very test this round applies to `SOURCE_NOT_SHOWN` and passes there. Fixed
 * by narrowing the claim to what the query actually establishes: no source
 * CONVERSATION was recorded. That is true for all four enum values.
 *
 * "No writer emits a non-session kind today" is NOT a defence — the histogram
 * is `{session: 540}` and live rows whose only evidence is non-session are 0 —
 * but that is exactly the "todo p" precedent this round invokes to justify
 * covering raw-no-evidence at 0 real rows. When a rule is expressed over an
 * enum, EVERY value is an execution point.
 *
 * ONE TEST PER KIND, for the reason T1-T3 are three tests: a single case
 * looping the kinds stops at its first failing assertion, so a mutant that
 * mishandles only `url` would be reported as "commit failed" and the url
 * verdict would be unobservable.
 *
 * IT ALSO PINS THE ON-CLAUSE PLACEMENT (F4). `service.ts` claims moving
 * `e.kind = 'session'` into WHERE "would silently restore the INNER JOIN", and
 * no test delivered that guarantee: review moved it to WHERE as a real tidy-up
 * would (`AND (e.kind = 'session' OR e.kind IS NULL)`) and got 291/291/0
 * twice. Under that mutation THIS row joins, is rejected by the WHERE,
 * produces no row, and falls to `no memory with id …` — which the shared
 * guards reject. A comment asserting a guarantee no test delivers is itself a
 * defect; this is the test that delivers it.
 */
for (const kind of ['commit', 'file', 'url']) {
  test(`sourceOf on a raw row whose ONLY evidence is kind=${kind} does not claim nothing was recorded`, async () => {
    const { root, registry, principal, service } = setup()
    const store = service.storeFor(principal, true)
    const { id } = await service.propose(
      { title: `only ${kind} evidence`, body: 'a real memory, written by the real writer', kind: 'fact' },
      principal,
    )
    // Swap the writer's `session` row for a non-session one CARRYING AN
    // EXCERPT. The excerpt is the whole point: it is the recorded passage the
    // reviewed sentence denied the existence of.
    store.db.prepare(`DELETE FROM evidence WHERE memory_id = ?`).run(id)
    store.db
      .prepare(`INSERT INTO evidence (memory_id, kind, ref, excerpt) VALUES (?, ?, ?, ?)`)
      .run(id, kind, `ref-${kind}`, 'THE REAL RECORDED PASSAGE')

    // The precondition, sampled at call time (P4 removes the INSERT and this
    // case must go red — it then degenerates into T4's no-evidence-at-all row).
    const evidence = store.db
      .prepare(`SELECT kind, excerpt FROM evidence WHERE memory_id = ?`)
      .all(id)
      .map((row) => ({ kind: row.kind, excerpt: row.excerpt }))
    assert.deepEqual(
      evidence,
      [{ kind, excerpt: 'THE REAL RECORDED PASSAGE' }],
      `the fixture must really hold ONE ${kind} evidence row WITH an excerpt, or this case ` +
        'measures the no-evidence path instead',
    )
    assert.equal(
      store.db
        .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
        .get(id).n,
      0,
      'and NO session row — that null-extension is what routes it into the raw branch',
    )

    const message = await captureSourceRefusal(service, id, principal)
    // Same guards as every other honest refusal, from the same definition.
    // `no memory with id` among them is what kills the ON->WHERE migration.
    assertHonestRefusal(message, id, RAW_SENTENCE(id))
    // AND THE OVERCLAIM ITSELF. A passage IS recorded, in `evidence.excerpt`;
    // a sentence saying none was is false against this store.
    assert.doesNotMatch(
      message,
      /no source passage was recorded|nothing was recorded|has no source passage/i,
      `a ${kind} evidence row holding "THE REAL RECORDED PASSAGE" is a recorded passage; the ` +
        'answer may say no source CONVERSATION was recorded, never that nothing was',
    )
    assert.match(
      message,
      /no source conversation was recorded/,
      'it states the discriminant the query actually applies: it joins kind=session only',
    )
    assert.doesNotMatch(message, /generated summary/, 'a raw row is not a generated summary')
    registry.dispose()
    cleanup(root)
  })
}

/**
 * T4d — the cell NOBODY BUILT: `derived ∈ {L1,L2,L3}` × `evidence.kind ∈
 * {commit,file,url}`. NINE independent tests.
 *
 * ⛔ WHY THIS EXISTS (rework, step 3c), and it is this round's own signature
 * failure committed a second time. Step 3b's headline finding (F3) was that
 * `no source PASSAGE was recorded` is FALSE when a row's only evidence is
 * `commit`/`file`/`url`, because `evidence.excerpt` on that row holds a real
 * recorded passage. It narrowed the RAW sentence to `no source CONVERSATION
 * was recorded` and wrote T4b×3 to pin it — and left the DERIVED sentence
 * saying `…so it has no source passage of its own.`
 *
 * THE SUITE CONVICTED ITSELF. T4b's own forbidden regex, twenty lines above,
 * is `/no source passage was recorded|nothing was recorded|has no source
 * passage/i`, and against the shipped DERIVED sentence it MATCHES, on the
 * substring `has no source passage`. The round had written the exact regex
 * that convicts its own other branch and applied it to one branch only.
 *
 * REPRODUCED IN ALL NINE CELLS before the fix, at home and in both member
 * domains, through the real registered `memory_recall`:
 *
 * ```
 * fixture : {"status":"active","derived":2},
 *           evidence=[{kind:"commit", excerpt:"THE REAL RECORDED PASSAGE"}]
 * BYTES   : "rollup-2-commit is a generated summary, not a stored memory, so
 *            it has no source passage of its own. The memory itself is
 *            unaffected."
 * FALSE CELLS: 9 / 9
 * ```
 *
 * THIS IS NOT THE REGISTERED TODO 3. That todo is a BEHAVIOUR gap (a
 * non-session excerpt cannot be retrieved). This is the SENTENCE BEING FALSE,
 * which is the defect class this round exists to eliminate.
 *
 * THE RAW FIX'S WORDING DOES NOT TRANSFER. "No source conversation was
 * recorded" would ALSO be wrong here: it frames the row as one that could have
 * had a conversation recorded and merely did not, which is what a RAW row is.
 * The honest derived claim is about WHAT KIND OF ROW IT IS — written by the
 * rebuild job out of other stored rows, never extracted from a turn — so the
 * sentence says `is a generated summary, not a memory recorded from a
 * conversation, so there is no source conversation of its own to show`. Every
 * clause is established by the `derived` column this branch read, and none of
 * them claims nothing was stored.
 *
 * ONE TEST PER CELL, for the reason T1-T3 and T4b are split: a single case
 * looping the grid stops at its first failing assertion, so a mutant that
 * mishandles only `L3 × url` would be reported as `L1 × commit` and the other
 * eight verdicts would be unobservable.
 */
for (const layer of DERIVED_LAYERS) {
  for (const kind of ['commit', 'file', 'url']) {
    test(`sourceOf on an ${LAYER_NAMES[layer]} whose ONLY evidence is kind=${kind} does not claim nothing was recorded`, async () => {
      const { root, registry, principal, ctx, service } = setup()
      const store = service.storeFor(principal, true)
      // EVERY raw write first (D9), then the derived plant — reversed, the
      // trigger retires the whole derived layer and this case measures an
      // absent row through the fail-closed path.
      await service.propose(
        { title: 'raw anchor', body: 'written before the plant, as D9 requires', kind: 'fact' },
        principal,
      )
      const id = plantDerivedRow(store, `rollup-${layer}-${kind}`, layer)
      // A NON-SESSION evidence row CARRYING AN EXCERPT. The excerpt is the
      // whole point: it is the recorded passage the old sentence denied.
      store.db
        .prepare(`INSERT INTO evidence (memory_id, kind, ref, excerpt) VALUES (?, ?, ?, ?)`)
        .run(id, kind, `ref-${kind}`, 'THE REAL RECORDED PASSAGE')

      // Preconditions sampled at CALL TIME, and all three of them, because any
      // one alone is satisfiable by a fixture that measures a different path:
      // the row must still be derived at THIS layer (D9 may have retired it),
      // it must carry the non-session excerpt (P4d removes it), and it must
      // carry no session row (or it answers normally, cell C).
      assertLiveRowAt(store, id, layer)
      assert.deepEqual(
        store.db
          .prepare(`SELECT kind, excerpt FROM evidence WHERE memory_id = ?`)
          .all(id)
          .map((row) => ({ kind: row.kind, excerpt: row.excerpt })),
        [{ kind, excerpt: 'THE REAL RECORDED PASSAGE' }],
        `the fixture must really hold ONE ${kind} evidence row WITH an excerpt on a derived ` +
          'row, or this case measures the no-evidence-at-all path T1-T3 already cover',
      )

      const message = await captureSourceRefusal(service, id, principal)
      // Every shared guard, from `helpers.mjs` — one definition for all six
      // surfaces. `no memory with id` among them is what kills an ON->WHERE
      // migration reaching a DERIVED row.
      assertHonestRefusal(message, id, DERIVED_SENTENCE(id))
      // ⛔ THE OVERCLAIM ITSELF — the byte-level defect this case was written
      // for. A passage IS recorded, in `evidence.excerpt`; a sentence saying
      // none was is false against this very store. Same regex T4b applies to
      // the raw sentence, now applied to the branch beside it.
      assert.doesNotMatch(
        message,
        /no source passage was recorded|nothing was recorded|has no source passage/i,
        `an L${layer} row with a ${kind} evidence row holding "THE REAL RECORDED PASSAGE" has ` +
          'a recorded passage; the answer may not claim nothing was recorded',
      )
      // What it may say instead: what KIND of row this is.
      assert.match(message, /generated summary/)
      assert.match(
        message,
        /not a memory recorded from a conversation/,
        'the honest derived claim is about the kind of row, not about a recording that failed',
      )
      // And NOT the raw sentence: a derived row is not a stored memory whose
      // conversation went unrecorded. Sharing one sentence across both would be
      // the v0.4.16 defect in miniature.
      assert.doesNotMatch(
        message,
        /is a stored memory, but no source conversation was recorded/,
        'a generated summary is not a raw row whose recording failed; two different facts',
      )

      // AND AT THE OUTERMOST RULER — ADR 0012 §5's whole finding is that
      // stopping at the service exit is what let three mutations survive.
      let thrown
      await assert.rejects(realRecallTool(ctx, service)({ sourceOf: id }, principal), (error) => {
        thrown = error
        return true
      })
      assert.ok(thrown instanceof MemoryInputError)
      assert.notEqual(thrown.message, SOURCE_NOT_SHOWN, 'not the four-cause disjunction')
      assertHonestRefusal(thrown.message, id, DERIVED_SENTENCE(id))
      assert.doesNotMatch(
        thrown.message,
        /no source passage was recorded|nothing was recorded|has no source passage/i,
        'the bytes the MODEL reads are where the falsehood was measured, so they are asserted',
      )
      assertLiveRowAt(store, id, layer)
      registry.dispose()
      cleanup(root)
    })
  }
}

test('sourceOf keeps searching after an uncited copy: a store further down the list still answers', async () => {
  // T4c — F5. `service.ts` claims the uncited branch "keep[s] searching … no
  // store that might hold a citable copy of this id may be skipped", and that
  // was the most important property of the new branch and completely untested:
  // review changed `continue` to `break` and got 291/291/0.
  //
  // The observable divergence: a row uncited in the FIRST store searched but
  // citable in a LATER one returns the words under shipped code, and throws
  // "no source conversation was recorded" under `break`. That is a read that
  // withholds evidence which is present and readable — D3.
  //
  // THE FIXTURE EXPLOITS THE REAL STORE ORDER. `readableStores` is
  // `[repo, global]`, in that order, so the uncited copy goes in the REPO
  // store and the citable copy in the GLOBAL one. `break` stops at the repo
  // store and never reaches the global copy.
  const { root, registry, principal, service } = setup()
  const repo = service.storeFor(principal, true)
  const global = service.globalStore(true)

  // The CITABLE copy, in the global store, written by the real writer so it
  // carries a genuine session evidence row and a real captured turn.
  const { id } = await service.propose(
    { title: 'a shared id', body: 'the copy that CAN be cited', kind: 'fact', scope: 'personal' },
    principal,
  )
  repo.tx(() =>
    captureTurn(
      repo,
      principal.session.id,
      1,
      collectTurnEvents(turnEvents(1, [userMessageEvent('THE WORDS BEHIND THE MEMORY')]), 1),
    ),
  )
  assert.equal(
    global.db.prepare(`SELECT count(*) AS n FROM memories WHERE id = ?`).get(id).n,
    1,
    'the citable copy lives in the GLOBAL store (searched second)',
  )
  assert.ok(
    global.db
      .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
      .get(id).n > 0,
    'and it really is citable — without evidence this case could not distinguish the branches',
  )

  // The UNCITED copy, same id, in the repo store — searched FIRST.
  repo.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', 'repo-local', 'active', 'a shared id', 'the copy that cannot be cited',
               'principal-explicit', 0, 9000000000000, ${LAYER.RAW})`,
    )
    .run(id)
  // BOTH halves, and the PRESENCE half first. ⛔ Asserting only "no session
  // evidence here" is VACUOUS: it is trivially true when the row is absent
  // altogether. Measured — probe P5 removed this whole insert and the case
  // stayed GREEN at 298/298/0, because with no row in the repo store the loop
  // never enters the uncited branch and `break` has nothing to break out of.
  // A precondition that survives the deletion of the thing it describes is the
  // vacuity this suite exists to catch, and it was in a test written to catch
  // vacuity. The precondition is "PRESENT, live, and UNCITED", so it is
  // asserted that way; P5 then turns red.
  const uncited = repo.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
  assert.ok(uncited, 'the FIRST store searched must really hold a copy of this id')
  assert.equal(uncited.status, 'active', 'and hold it live, or it takes the D5 path instead')
  assert.equal(
    repo.db
      .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
      .get(id).n,
    0,
    'and hold it UNCITED — a present-but-uncited copy in store 1 is what makes the loop ' +
      'continuation observable at all (P5 drops this row and the case must go red)',
  )

  // Shipped code walks past the uncited copy and answers from the citable one.
  // Under `break` this call throws the raw sentence instead.
  const turns = await service.source(id, principal, SOURCE_TURN_LIMIT)
  assert.ok(
    turns.length > 0,
    'a citable copy exists in a readable store, so the words must come back; stopping at the ' +
      'first uncited copy withholds evidence that is present and readable (D3)',
  )
  assert.match(
    turns.map((turn) => turn.text).join('\n'),
    /THE WORDS BEHIND THE MEMORY/,
    'and they are the real recorded words, not an empty result that merely avoided throwing',
  )
  registry.dispose()
  cleanup(root)
})

/**
 * T4e — WHICH COPY the sentence is about, when two readable stores hold the id
 * uncited at DIFFERENT layers. Two independent tests, one per arrangement.
 *
 * ⛔ WHY THIS EXISTS (rework, step 3c). `existsWithoutSource` was a single
 * variable the store loop OVERWROTE (`=`), so the LAST uncited store decided
 * the sentence, and nothing pinned it. Two mutations survived at 298/298/0,
 * both proven landed in `lib/service.js`:
 *   MA  `existsWithoutSource = cited.derived` -> `??=`  (first-wins)
 *   MP  `.reverse()` on the store list
 *
 * IT IS NOT BEHAVIOUR-NEUTRAL. Measured on the build that carried `=`, the
 * caller received the OPPOSITE sentence for the two arrangements:
 *   derived(repo) + raw(global) => "…is a stored memory, but no source
 *                                   conversation was recorded…"   (RAW won)
 *   raw(repo) + derived(global) => "…is a generated summary…"     (DERIVED won)
 * In the first line the caller is told the row IS a stored memory while THIS
 * SESSION'S OWN repo store holds it as a generated summary. The sentence may
 * be true of some copy; the code made no claim about WHICH, so the caller
 * cannot tell. An answer whose subject is undefined is not an honest answer.
 *
 * THE RULE PINNED HERE IS FIRST-WINS, nearest scope first, and it is asserted
 * as an OBSERVABLE — "the answer describes the REPO copy" — rather than by
 * reading the implementation. Three reasons it is the honest choice, all
 * checkable: (1) the citable branch in the same loop already returns on first
 * hit, so `=` ran two opposite precedence rules in one loop depending on
 * whether evidence happened to exist; (2) `forget` resolves the same
 * "which copy" question with `.find()` — first-wins — so `source` now
 * describes the row `forget` would act on; (3) `readableStores` documents
 * nearest-scope-first as the list's meaning.
 *
 * WHY A RULE AND NOT AN ASSERTION THAT THE STATE CANNOT ARISE. `forget`'s
 * comment claims "Ids are unique across stores"; that was CHECKED, and nothing
 * enforces it. All four id-minting sites are bare `randomUUID()`
 * (`extract.ts:339`, `rebuild.ts:354`, `rebuild.ts:561`, `service.propose`),
 * none probes another store, and `memories.id`'s `UNIQUE` constraint is
 * per-FILE — SQLite cannot express uniqueness across separate database files.
 * The state is directly representable, which is how the readings above were
 * produced, so a READ path must answer it rather than crash on it.
 *
 * TWO TESTS, NOT ONE LOOP: `.reverse()` (MP) and `=` (MA) are different
 * mutations, and a single looping case would stop at the first and leave the
 * second arrangement's verdict unobservable.
 */
for (const arrangement of [
  { name: 'derived in the repo store, raw in the global one', repo: LAYER.SCENARIO, global: LAYER.RAW, expected: DERIVED_SENTENCE, other: RAW_SENTENCE },
  { name: 'raw in the repo store, derived in the global one', repo: LAYER.RAW, global: LAYER.SCENARIO, expected: RAW_SENTENCE, other: DERIVED_SENTENCE },
]) {
  test(`sourceOf answers about the NEAREST uncited copy: ${arrangement.name}`, async () => {
    const { root, registry, principal, service } = setup()
    const repo = service.storeFor(principal, true)
    const global = service.globalStore(true)
    const id = 'collide-uncited'
    // Plant the SAME id, uncited, in both readable stores at different layers.
    // Written directly because no writer can produce a cross-store collision —
    // that is the point: the state is representable, not reachable by design.
    const plant = (store, layer) =>
      store.db
        .prepare(
          `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
           VALUES (?, 'fact', ?, 'active', 'a colliding id', 'body', ?, 0, 9000000000000, ?)`,
        )
        .run(
          id,
          store.kind === 'global' ? 'private' : 'repo-local',
          layer === LAYER.RAW ? 'principal-explicit' : DERIVED_PROVENANCE,
          layer,
        )
    plant(repo, arrangement.repo)
    plant(global, arrangement.global)

    // BOTH copies must really be there, at the layers claimed, and BOTH
    // uncited — a precondition that survives the deletion of what it describes
    // pins nothing (the P5 lesson from T4c).
    for (const [store, layer, which] of [
      [repo, arrangement.repo, 'repo'],
      [global, arrangement.global, 'global'],
    ]) {
      const row = store.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
      assert.ok(row, `the ${which} store must really hold a copy of this id`)
      assert.equal(row.status, 'active', `and hold it live, or the ${which} copy takes D5`)
      assert.equal(row.derived, layer, `and at layer ${layer} exactly — the discriminant`)
      assert.equal(
        store.db
          .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
          .get(id).n,
        0,
        `and UNCITED in the ${which} store — a citable copy would answer instead of refusing`,
      )
    }

    const message = await captureSourceRefusal(service, id, principal)
    // Every shared guard still applies: whichever copy answers, the answer is
    // still an honest refusal.
    assertHonestRefusal(message, id, arrangement.expected(id))
    // AND the precedence itself, stated as an observable: the sentence
    // describes the REPO copy, because the repo store is searched first.
    // `.reverse()` (MP) and `=` (MA) each make this the OTHER sentence.
    assert.notEqual(
      message,
      arrangement.other(id),
      'the answer describes the copy in the store searched FIRST (nearest scope); receiving ' +
        'the other sentence means iteration order silently chose the subject, and the caller ' +
        'cannot tell which copy the answer is about',
    )
    registry.dispose()
    cleanup(root)
  })
}

test('D5 survives: a FORGOTTEN memory and a never-existent id stay byte-identical', async () => {
  // T5. D5 requires that forget be unobservable — a forgotten memory must be
  // indistinguishable from one that never existed, or the denial itself leaks
  // that something was there.
  //
  // ZERO COVERAGE BEFORE THIS ROUND, verified: `grep -rn "or it was forgotten"
  // test/ src/` matched ONLY `src/service.ts`. Splitting the disjunction into
  // "memory X was forgotten" vs "no memory with id X" left the whole suite at
  // 280/0 — mutation M6 below, which this case turns red.
  //
  // It also guards THIS round's fix from the other side: `m.status !=
  // 'tombstone'` must stay in the WHERE clause. Move it into the LEFT JOIN's ON
  // clause and a tombstoned row starts matching, takes the new "no source
  // recorded" branch, and announces that a forgotten memory exists.
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'to be forgotten', body: 'this memory will be tombstoned', kind: 'fact' },
    principal,
  )
  await service.forget(id, principal)
  const store = service.storeFor(principal, true)
  assert.equal(
    store.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(id).status,
    'tombstone',
    'the fixture must really hold a tombstoned row, or this case compares two absent ids',
  )

  const forgotten = await captureSourceRefusal(service, id, principal)
  const neverExisted = await captureSourceRefusal(service, `${id}-never-existed`, principal)

  // Compared with the id substituted out, because the id is the ONE thing that
  // legitimately differs — and it is the caller's own input, so it tells them
  // nothing they did not already know. Everything else must match byte for byte.
  assert.equal(
    forgotten.replace(id, '<ID>'),
    neverExisted.replace(`${id}-never-existed`, '<ID>'),
    'a forgotten memory and an id that never existed must be indistinguishable (D5); any ' +
      'difference here is a leak that something used to be there',
  )
  // And neither may drift into this round's new sentences: a tombstoned row
  // must not be reported as an existing row with no source.
  for (const message of [forgotten, neverExisted]) {
    assert.match(message, /no memory with id/)
    assert.doesNotMatch(
      message,
      /generated summary|no source conversation was recorded/,
      'the new branch must not swallow the tombstone case — that would announce the row exists',
    )
  }
  registry.dispose()
  cleanup(root)
})

test('the model RECEIVES the honest sentence, not a denial — at the tool layer', async () => {
  // T6. ADR 0012 §5 records that stopping assertions at `service.source()`'s
  // exit is precisely what let three mutations survive the whole suite: the
  // damage happened AFTER that exit, in the render. So this case asserts the
  // bytes the model actually gets.
  //
  // The path is: `service.source` throws MemoryInputError -> `asToolFailure`
  // re-throws it untouched (it is a deliberate, already-phrased answer) -> the
  // platform prefixes `Error: ` and sets `isError: true`. So the sentence
  // reaches the model verbatim, under an error flag.
  //
  // THE `isError: true` WART IS ASSERTED, NOT GLOSSED. It is acceptable only
  // because `source()`'s contract is already error-shaped — every "cannot
  // answer" exit throws — and adding a second exit shape for this one case
  // would be the second mechanism this repo forbids. Pinning it here means a
  // later change of shape is a test failure rather than a discovery.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await service.propose(
    { title: 'raw anchor', body: 'written before the plant, as D9 requires', kind: 'fact' },
    principal,
  )
  const id = plantDerivedRow(store, 'tool-layer-rollup', LAYER.SCENARIO)
  assertLiveRowAt(store, id, LAYER.SCENARIO)

  const recall = realRecallTool(ctx, service)
  let thrown
  await assert.rejects(recall({ sourceOf: id }, principal), (error) => {
    thrown = error
    return true
  })
  // 1. It survives `asToolFailure` as itself, NOT as the generic "the memory
  //    store is unavailable right now" — that sentence would be false and
  //    would tell the model to retry something that will never succeed.
  assert.ok(thrown instanceof MemoryInputError, 'a deliberate answer passes through untouched')
  assert.doesNotMatch(thrown.message, /store is unavailable/)
  // 2. The bytes the model reads. Same guards the raw sentence now carries at
  //    this same layer (T4), from one definition — including "the memory is
  //    untouched, and the message does not contradict that".
  assert.doesNotMatch(thrown.message, /No stored memories matched/)
  assert.notEqual(thrown.message, RECALL_NO_MATCH)
  assert.notEqual(thrown.message, SOURCE_NOT_SHOWN, 'and it is not the four-cause disjunction')
  assertHonestRefusal(thrown.message, id, DERIVED_SENTENCE(id))
  assert.match(thrown.message, /generated summary/)
  assert.match(thrown.message, /not a memory recorded from a conversation/)
  // The reworked overclaim must not reach the model either (step 3c).
  assert.doesNotMatch(
    thrown.message,
    /no source passage was recorded|nothing was recorded|has no source passage/i,
    'the bytes the model reads may not claim nothing was recorded',
  )
  assertLiveRowAt(store, id, LAYER.SCENARIO)
  registry.dispose()
  cleanup(root)
})

test('SOURCE_NOT_SHOWN still covers the genuinely-unshowable case, unchanged', async () => {
  // T7. The ADR 0012 fix must not regress: a row that HAS evidence but whose
  // words cannot be produced still renders the four-cause disjunction, and
  // still does NOT throw. This is the boundary of the new branch — one row with
  // evidence, one without, same store, different answers — so it also proves
  // the new branch did not swallow the old case.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  // `propose` writes an evidence row with no excerpt and captures no turn:
  // evidence EXISTS, the words cannot be shown. That is exactly the domain of
  // SOURCE_NOT_SHOWN, and it is a different fact from "there is no source".
  const { id } = await service.propose(
    { title: 'deploy with make', body: 'make deploy', kind: 'procedure' },
    principal,
  )
  assert.ok(
    store.db
      .prepare(`SELECT count(*) AS n FROM evidence WHERE memory_id = ? AND kind = 'session'`)
      .get(id).n > 0,
    'the precondition is that evidence DOES exist — without it this case would be testing the ' +
      'new branch instead of the one it guards',
  )

  const { value, text } = await realRecallTool(ctx, service)({ sourceOf: id }, principal)
  assert.equal(value.hits.length, 0, 'nothing could be shown')
  assert.equal(text, SOURCE_NOT_SHOWN, 'byte-for-byte the sentence ADR 0012 shipped')
  assert.notEqual(text, RECALL_NO_MATCH)
  // And the new sentences must NOT have leaked onto this case: the row has a
  // source, so saying it has none would be a new false statement.
  assert.doesNotMatch(text, /generated summary/)
  assert.doesNotMatch(text, /no source passage/)
  registry.dispose()
  cleanup(root)
})

/**
 * T8 — THE THREE MODEL-FACING DESCRIPTION STRINGS, held to the SAME shared
 * guard as the refusal sentences.
 *
 * ⛔ WHY THIS WAS REWRITTEN (rework, step 3c). The previous version asserted
 * `match(/no source passage of its own/)` plus a few negative pins against
 * specific rejected byte strings — and this repo's own NEG1-NEG4 criterion
 * says a positive-only assertion passes on a message that says the right thing
 * AND the wrong thing. Three mutations, each proven landed in `lib/tools.js`,
 * ALL SURVIVED at 298/298/0:
 *   MK  `sourceOf` param: `The memory is unaffected either way.`
 *                      -> `Forget it and recall it again to fix this.`
 *   MM  tool description + `Start a session inside that checkout and retry.`
 *       (the literal v0.4.16 false-advice payload, deleted for being false)
 *   MN  `GUIDANCE_SECTION` + `If none, forget it.` — priced at 157 <= 160, so
 *       the load-time budget assertion does NOT catch it, and this string is
 *       paid on EVERY request.
 *
 * The fix is NOT more one-off `doesNotMatch` byte pins: those pin rejected
 * spellings rather than the property, and the next payload invented is
 * unguarded again. All three strings now run `assertNoFalseAdvice` from
 * `helpers.mjs` — the SAME negative set `assertHonestRefusal` applies to the
 * two `service.ts` sentences. One definition, six surfaces.
 */
test('the three model-facing description strings carry no false advice, and describe all three outcomes', async () => {
  let captured
  registerTools(
    { ...fakeCtx({}), tools: { register: (tool) => { if (tool.name === 'memory_recall') captured = tool } } },
    {},
  )
  assert.ok(captured, 'memory_recall must be registered')
  // Read off the NORMALISED schema `defineTool` produces, not the literal in
  // `tools.ts`: that object is what is actually put on the wire to the model,
  // so a change that stopped the description reaching it would be visible here
  // and invisible to a test that re-read the source literal.
  const description = captured.parameters.properties.sourceOf.description
  assert.ok(description, 'the sourceOf parameter must carry a description at all')

  // ---- THE SHARED GUARD, over all three strings. This is what kills MK, MM
  // ---- and MN, and it is the same function the refusal sentences run.
  const SURFACES = [
    ['the memory_recall tool description', captured.description],
    ['the sourceOf parameter description', description],
    ['GUIDANCE_SECTION.text', GUIDANCE_SECTION.text],
  ]
  for (const [label, text] of SURFACES) {
    assertNoFalseAdvice(text, label)
  }

  // ---- The parameter description must still describe ALL THREE outcomes.
  // Outcome 1: the stored quotation.
  assert.match(description, /quote/, 'the quotation outcome is still described')
  // Outcome 2: the conversation window.
  assert.match(description, /cited conversation/, 'the transcript outcome is still described')
  // Outcome 3: THIS round's — and it must name the populated case by name.
  // Measured on the real stores: 23 derived rows, all 23 with zero evidence
  // rows, all 23 reachable through `recall`.
  assert.match(
    description,
    /no source (passage|conversation) of its own/,
    'the third outcome must be described, or the model reads an exhaustive list of two and ' +
      'treats the third answer as a fault',
  )
  assert.match(description, /generated summary/, 'and name the populated case')
  // It must no longer promise a return unconditionally. `Returns the stored
  // source behind that memory` is the exact byte sequence that became false.
  assert.doesNotMatch(
    description,
    /Returns the stored source behind that memory/,
    'the unconditional promise is what this round falsified',
  )
  // And it must keep the clause MK replaced: the read path damaged nothing.
  // Positive AND negative, because MK swapped a true clause for a false one
  // and a negative-only guard would pass on the clause simply being deleted.
  assert.match(
    description,
    /memory is unaffected either way/i,
    'the parameter description tells the model the drill-down changes nothing; MK replaced ' +
      'exactly this clause with advice to forget and re-save the memory',
  )

  // ---- The tool DESCRIPTION carries the same unconditional promise and gets
  // ---- the same treatment — a second execution point, not a copy of the first.
  assert.doesNotMatch(
    captured.description,
    /read the source passage that memory was drawn from/,
    'the tool description promised a read that cannot always happen',
  )
  assert.match(captured.description, /no source (passage|conversation) of its own/)

  // ---- GUIDANCE_SECTION: paid on EVERY request, and budget-constrained.
  //
  // ⛔ REWORK (S1): this was negative-only against ONE byte string,
  // `read the source passage behind it`, which pins a rejected spelling rather
  // than the property. Changing `look up` to `fetch` — the same unconditional
  // promise in a different word — survived. The assertion below states the
  // PROPERTY: whatever verb this sentence uses about the source passage, it
  // must describe the ATTEMPT, never guarantee the result, because for a
  // generated summary and for a row with no recorded source conversation there
  // is no result to guarantee.
  assert.doesNotMatch(
    GUIDANCE_SECTION.text,
    /\b(read|fetch|get|retrieve|returns?|shows?|see|obtain|view)\b[^.]*\bsource passage\b/i,
    'the guidance must not promise the source passage comes back — it names an attempt ' +
      '("look up"), because two of the three outcomes return no passage at all',
  )
  assert.match(
    GUIDANCE_SECTION.text,
    /look up the source passage behind it/,
    'and it must still tell the model what sourceOf is FOR; deleting the clause would satisfy ' +
      'the negative above while making the guidance useless',
  )
  // Priced here as well as at load, because the load-time assertion only fires
  // ABOVE the budget: MN measured 157 <= 160 and sailed through it. The budget
  // guard is not, and never was, an honesty guard — that is `assertNoFalseAdvice`
  // above. This one keeps the per-request cost from drifting.
  assert.ok(
    estimateTokens(GUIDANCE_SECTION.text) <= GUIDANCE_BUDGET_TOKENS,
    `the guidance section is ${estimateTokens(GUIDANCE_SECTION.text)} tokens, past its budget`,
  )
})

// ---------------------------------------------- Personal Memory -----------

test('personal scope writes to the global store as private; repo scope stays repo-local', async () => {
  const { root, registry, principal, service } = setup()
  const personal = await service.propose(
    { title: 'answer in Chinese', body: 'the user prefers Chinese replies', kind: 'preference', scope: 'personal' },
    principal,
  )
  const repoMem = await service.propose(
    { title: 'uses pnpm', body: 'this repo uses pnpm', kind: 'fact' },
    principal,
  )

  const global = registry.get(GLOBAL_STORE_KEY)
  const repo = service.storeFor(principal, false)
  assert.notEqual(global, repo, 'two distinct stores')
  assert.equal(
    global.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(personal.id).visibility,
    'private',
  )
  assert.equal(
    repo.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(repoMem.id).visibility,
    'repo-local',
  )
  // Each store holds only its own.
  assert.equal(global.db.prepare(`SELECT count(*) c FROM memories`).get().c, 1)
  assert.equal(repo.db.prepare(`SELECT count(*) c FROM memories`).get().c, 1)
  registry.dispose()
  cleanup(root)
})

test('coding memory: filterable apart from fact, and free to take either scope', async () => {
  // The two acceptance criteria for 4x4 phase 1 (docs/design/4x4-memory.md §5).
  // Coding is "an engineering lesson that survives a change of repository";
  // fact is "true of THIS repo and false elsewhere". They are different kinds
  // precisely so recall can tell them apart.
  const { root, registry, principal, service } = setup()

  await service.propose(
    { title: 'sqlite WAL pragma order', body: 'set busy_timeout before switching journal_mode', kind: 'coding', scope: 'personal' },
    principal,
  )
  await service.propose(
    { title: 'sqlite store layout', body: 'this repo keeps its sqlite stores under packages/memory', kind: 'fact' },
    principal,
  )

  // 1) The two kinds are separately filterable.
  const coding = await service.recall({ query: 'sqlite', kind: 'coding' }, principal)
  const facts = await service.recall({ query: 'sqlite', kind: 'fact' }, principal)
  assert.deepEqual(coding.hits.map((h) => h.kind), ['coding'])
  assert.deepEqual(facts.hits.map((h) => h.kind), ['fact'])
  // Both are still found when the caller does not filter — recall spans scopes.
  assert.equal((await service.recall({ query: 'sqlite' }, principal)).hits.length, 2)

  // 2) kind and scope stay orthogonal: the SAME kind can go to either store.
  // A lesson that travels is personal; one that only holds here is repo-local.
  const repoScoped = await service.propose(
    { title: 'our vitest shim', body: 'the vitest shim here needs a manual reset between suites', kind: 'coding' },
    principal,
  )
  const global = registry.get(GLOBAL_STORE_KEY)
  const repo = service.storeFor(principal, false)
  assert.equal(
    global.db.prepare(`SELECT count(*) c FROM memories WHERE kind = 'coding'`).get().c,
    1,
    'the portable lesson lives in the cross-repo store',
  )
  assert.equal(
    repo.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(repoScoped.id).visibility,
    'repo-local',
    'the repo-specific lesson stays here — no kind-to-scope binding',
  )
  registry.dispose()
  cleanup(root)
})

test('D2 holds in both directions: neither store accepts the other\'s visibility', () => {
  const { root, registry } = openRegistry()
  const repo = registry.open('k1')
  const global = registry.openGlobal()
  const insert = (store, visibility) =>
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'fact', ?, 'active', 't', 'b', 'human', 0, 0)`,
      )
      .run(Math.random().toString(36), visibility)

  assert.throws(() => insert(repo, 'private'), /does not match/)
  assert.throws(() => insert(global, 'repo-local'), /does not match/)
  assert.throws(() => insert(global, 'team-shareable'), /does not match/)
  insert(repo, 'repo-local')
  insert(global, 'private')
  registry.dispose()
  cleanup(root)
})

test('recall and injection span both scopes; personal memories lead the packet', async () => {
  const { root, registry, principal, ctx, service } = setup()
  await service.propose(
    { title: 'reply in Chinese', body: 'user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  await service.propose(
    { title: 'build with pnpm', body: 'this repo uses pnpm', kind: 'fact' },
    principal,
  )

  // Recall spans both stores. The query is escaped as a literal phrase
  // (anti-injection, §4.3), so each scope is probed with its own term.
  const personalHits = await service.recall({ query: 'Chinese' }, principal)
  assert.deepEqual(personalHits.hits.map((h) => h.title), ['reply in Chinese'])
  const repoHits = await service.recall({ query: 'pnpm' }, principal)
  assert.deepEqual(repoHits.hits.map((h) => h.title), ['build with pnpm'])
  // ...and one query matching both returns both, personal first.
  const both = await service.recall({ query: 'user' }, principal)
  assert.ok(both.hits.length >= 1)

  // injection carries both, personal first
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /Chinese/)
  assert.match(packet, /pnpm/)
  assert.ok(
    packet.indexOf('Chinese') < packet.indexOf('pnpm'),
    'personal memories frame the repo ones',
  )
  registry.dispose()
  cleanup(root)
})

test('personal memories survive a session with no repo affiliation', async () => {
  const { root, registry, principal, service } = setup()
  await service.propose(
    { title: 'be concise', body: 'the user wants short answers', kind: 'preference', scope: 'personal' },
    principal,
  )

  // A session outside any git tree: no repo store, but personal memory holds.
  const stray = fakeAgent({ id: 'stray', cwd: tempRoot() })
  const strayCtx = fakeCtx({ agents: [stray] })
  service.ctx = strayCtx
  assert.equal(service.storeFor(stray, false), undefined, 'no repo store')

  const hits = await service.recall({ query: 'concise' }, stray)
  assert.equal(hits.hits.length, 1, 'personal memory is still recallable')
  const packet = buildContextProvider(strayCtx, service)({ agent: stray })
  assert.match(packet, /concise/, 'and still injected')
  registry.dispose()
  cleanup(root)
})

test('forget reaches a personal memory by id without naming its store', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'use emoji', body: 'the user likes emoji', kind: 'preference', scope: 'personal' },
    principal,
  )
  const report = await service.forget(id, principal)
  assert.equal(report.id, id)
  const hits = await service.recall({ query: 'emoji' }, principal)
  assert.equal(hits.hits.length, 0)
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------ dedup / update ---------

test('propose surfaces near-duplicates so the model can collapse them', async () => {
  const { root, registry, principal, service } = setup()
  const first = await service.propose(
    { title: 'reply in Chinese', body: 'the user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  assert.deepEqual(first.similar, [], 'nothing existed yet')

  // Saying it again a different way: the overlap is reported back.
  const second = await service.propose(
    { title: 'user prefers Chinese replies', body: 'answer in Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  assert.equal(second.similar.length, 1)
  assert.equal(second.similar[0].id, first.id)

  // Different kind ⇒ not offered (a fact never supersedes a preference).
  const other = await service.propose(
    { title: 'Chinese docs live in docs/zh', body: 'translations', kind: 'fact' },
    principal,
  )
  assert.deepEqual(other.similar, [])
  registry.dispose()
  cleanup(root)
})

test('replaces supersedes atomically: one active entry survives, chain is recorded', async () => {
  const { root, registry, principal, service } = setup()
  const v1 = await service.propose(
    { title: 'use npm', body: 'install with npm', kind: 'fact' },
    principal,
  )
  const v2 = await service.propose(
    { title: 'use pnpm', body: 'install with pnpm, npm is wrong', kind: 'fact', replaces: v1.id },
    principal,
  )

  const store = service.storeFor(principal, false)
  const rows = store.db
    .prepare(`SELECT id, status, superseded_by FROM memories ORDER BY created_at`)
    .all()
  assert.equal(rows.length, 2)
  const old = rows.find((r) => r.id === v1.id)
  assert.equal(old.status, 'superseded')
  assert.equal(old.superseded_by, v2.id, 'the chain records what replaced it')

  // Only the survivor is recalled and injected.
  const hits = await service.recall({ query: 'install' }, principal)
  assert.deepEqual(hits.hits.map((h) => h.id), [v2.id])
  registry.dispose()
  cleanup(root)
})

test('replaces refuses an unknown or already-superseded target (fail loud)', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact', replaces: 'ghost' }, principal),
    /cannot replace/,
  )
  const v1 = await service.propose({ title: 'a', body: 'b', kind: 'fact' }, principal)
  await service.propose({ title: 'a2', body: 'b2', kind: 'fact', replaces: v1.id }, principal)
  // Second attempt against the now-superseded entry fails, and writes nothing.
  await assert.rejects(
    service.propose({ title: 'a3', body: 'b3', kind: 'fact', replaces: v1.id }, principal),
    /cannot replace/,
  )
  const store = service.storeFor(principal, false)
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories`).get().c, 2, 'no orphan row')
  registry.dispose()
  cleanup(root)
})

test('replaces cannot cross scopes (a personal memory is not in the repo store)', async () => {
  const { root, registry, principal, service } = setup()
  const personal = await service.propose(
    { title: 'be terse', body: 'short answers', kind: 'preference', scope: 'personal' },
    principal,
  )
  await assert.rejects(
    service.propose(
      { title: 'be terse here', body: 'short answers', kind: 'preference', replaces: personal.id },
      principal,
    ),
    /cannot replace/,
  )
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------------- metrics ---------

test('metrics snapshot reports the §12 trigger indicators from the store', async () => {
  const { root, registry, principal, service } = setup()
  const a = await service.propose({ title: 'alpha fact', body: 'body one', kind: 'fact' }, principal)
  await service.propose({ title: 'beta fact', body: 'body two', kind: 'fact', replaces: a.id }, principal)
  const gone = await service.propose({ title: 'gamma', body: 'body three', kind: 'fact' }, principal)
  await service.forget(gone.id, principal)
  await service.recall({ query: 'beta' }, principal)

  const store = service.storeFor(principal, false)
  const m = collectMetrics(store, Date.now())
  assert.equal(m.kind, 'repo')
  assert.equal(m.activeCount, 1, 'one survivor')
  assert.ok(m.injectableTokens > 0, 'packet size is measured, not guessed')
  assert.equal(m.retrievedRate, 1, 'the survivor was recalled once')
  assert.ok(m.overturnRate > 0 && m.overturnRate < 1, `overturn tracked: ${m.overturnRate}`)
  assert.equal(m.pendingJobs, 0)
  assert.equal(m.oldestPendingJobAgeMs, 0, 'no pending job ⇒ no age')
  assert.equal(m.deadLettered, 0)
  registry.dispose()
  cleanup(root)
})

test('metrics: the recall miss rate is read from L0, not from a counter', () => {
  // This number prices the deferred retrieval-fusion work. It is computed from
  // the recall tool's own recorded output, so there is no counter to maintain
  // and no new column — the evidence was already being kept.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  assert.equal(collectMetrics(store, Date.now()).recallMissRate, 0, 'no calls => no division by zero')

  store.tx(() =>
    captureTurn(store, 'sess-metrics', 1, [
      { seq: 1, label: 'tool:memory_recall', provenance: 'tool-output', text: RECALL_NO_MATCH },
      { seq: 2, label: 'tool:memory_recall', provenance: 'tool-output', text: 'The following are stored memory entries...' },
      { seq: 3, label: 'tool:memory_recall', provenance: 'tool-output', text: RECALL_NO_MATCH },
      { seq: 4, label: 'user', provenance: 'human', text: 'unrelated turn content' },
    ]),
  )
  const m = collectMetrics(store, Date.now())
  assert.equal(m.recallCalls, 3, 'only recall rows count')
  assert.equal(m.recallMissRate, 0.667)

  // The metric matches the tool's own rendered marker, so the two must stay in
  // step: if that wording changed, this would count zero misses forever and the
  // fusion decision would rest on a silently broken number.
  assert.equal(renderFramed([], 500, true), '', 'an empty result renders empty...')
  assert.equal(RECALL_NO_MATCH, 'No stored memories matched.', '...and the tool substitutes this marker')
  registry.dispose()
  cleanup(root)
})
test('capturing tool CALLS does not move the recall miss rate', () => {
  // The reason `tool/call` rows get their own label family. `metrics.ts` and
  // `scripts/inspect.mjs` read the recall miss rate as a population:
  //   count(label = 'tool:memory_recall' AND text LIKE 'No stored memories matched.%')
  //   / count(label = 'tool:memory_recall')
  // Recording a REQUEST under the same label would inflate the denominator and
  // never the numerator — every `memory_recall` call would add one non-miss —
  // silently halving the number that gates the retrieval-fusion decision
  // (ADR 0005). The metric would keep returning a value; the value would be
  // wrong, and no test that locks the marker's WORDING would notice.
  const { root, registry } = openRegistry()
  const store = registry.open('k1')

  // The same three results as the test above, now with their requests beside
  // them, exactly as the fixed capture path writes them.
  const rows = collectTurnEvents(
    turnEvents(1, [
      toolCallEvent(1, 'c1', 'memory_recall', '{"query":"工程取舍","kind":"fact"}'),
      toolResultEvent(1, 'c1', RECALL_NO_MATCH),
      toolCallEvent(1, 'c2', 'memory_recall', '{"query":"预算容器"}'),
      toolResultEvent(1, 'c2', 'The following are stored memory entries...'),
      toolCallEvent(1, 'c3', 'memory_recall', '{"query":"tool/call"}'),
      toolResultEvent(1, 'c3', RECALL_NO_MATCH),
    ]),
    1,
  )
  store.tx(() => captureTurn(store, 'sess-metrics', 1, rows))

  // The requests ARE stored — this is not "the rows were dropped again".
  assert.equal(rows.length, 6, 'both families are captured')
  assert.equal(
    store.db
      .prepare(`SELECT count(*) c FROM conversations WHERE label = 'tool-call:memory_recall'`)
      .get().c,
    3,
    'the requests landed under their own family',
  )

  const m = collectMetrics(store, Date.now())
  assert.equal(m.recallCalls, 3, 'the RESULT family is still the population')
  assert.equal(m.recallMissRate, 0.667, 'and the rate is untouched by the new rows')

  // Stated as the property rather than as two numbers: no `tool-call:` row may
  // be visible to a consumer matching the result family. Every consumer does
  // so by exact equality, which is what makes a distinct prefix sufficient.
  assert.equal(
    store.db
      .prepare(`SELECT count(*) c FROM conversations WHERE label = 'tool:memory_recall'`)
      .get().c,
    3,
    'exact-equality matching cannot see the request family',
  )
  registry.dispose()
  cleanup(root)
})

test('metrics report oldest pending job age and dead letters', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at, completed_at)
         VALUES ('old','extract','{}','pending',0,0,?,NULL),
                ('new','extract','{}','pending',0,0,?,NULL),
                ('bad','extract','{}','failed',6,0,0,?)`,
      )
      .run(now - 600_000, now - 1_000, now)
  })
  const m = collectMetrics(store, now)
  assert.equal(m.pendingJobs, 2)
  assert.ok(m.oldestPendingJobAgeMs >= 600_000, 'age comes from the OLDEST pending job')
  assert.equal(m.deadLettered, 1)
  registry.dispose()
  cleanup(root)
})

// --------------------------------------------------------- decay ---------

/** Insert an active memory with an explicit age and optional last hit. */
const seedAged = (store, id, ageMs, hitAgoMs) => {
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'fact', 'repo-local', 'active', ?, 'body', 'human', 0, ?)`,
      )
      .run(id, `title ${id}`, now - ageMs)
    if (hitAgoMs !== undefined) {
      store.db
        .prepare(`INSERT INTO usage (memory_id, retrieved, last_hit_at) VALUES (?, 1, ?)`)
        .run(id, now - hitAgoMs)
    }
  })
}

const claimDecay = (store) => {
  const now = Date.now()
  enqueueJob(store, 'decay', 'd1', {}, 0)
  return claimNextJob(store, now, now + 60_000)
}

test('decay: idle entries sleep, recently used ones stay, small stores are left alone', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const DAY = 86_400_000

  // Below the floor: nothing sleeps even though everything is old.
  seedAged(store, 'lonely', 200 * DAY)
  let report = runDecayJob(store, claimDecay(store), Date.now())
  assert.equal(report.slept, 0, 'a small store has no noise problem')

  // Above the floor: old and unused sleeps; old but recently hit does not.
  for (let i = 0; i < 60; i++) seedAged(store, `old${i}`, 200 * DAY)
  seedAged(store, 'useful', 200 * DAY, 1 * DAY)
  store.db.prepare(`DELETE FROM jobs`).run()
  report = runDecayJob(store, claimDecay(store), Date.now())
  assert.ok(report.slept >= 60, `idle entries slept: ${report.slept}`)
  assert.equal(
    store.db.prepare(`SELECT status FROM memories WHERE id = 'useful'`).get().status,
    'active',
    'recently retrieved entries stay awake',
  )
  registry.dispose()
  cleanup(root)
})

test('decay: revival happens in the batch, never on the read path (D4)', async () => {
  const { root, registry, principal, service } = setup()
  const store = service.storeFor(principal, true)
  const now = Date.now()
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES ('sleeper','fact','repo-local','dormant','hibernating fact','body','human',0,0)`,
      )
      .run()
  })

  // A dormant memory is invisible to recall...
  assert.equal((await service.recall({ query: 'hibernating' }, principal)).hits.length, 0)
  // ...and reading did NOT wake it (no authoritative change on a read).
  assert.equal(
    store.db.prepare(`SELECT status FROM memories WHERE id = 'sleeper'`).get().status,
    'dormant',
  )

  // A recent hit (however recorded) revives it in the next decay batch.
  store.tx(() => {
    store.db
      .prepare(`INSERT INTO usage (memory_id, retrieved, last_hit_at) VALUES ('sleeper', 3, ?)`)
      .run(now - 86_400_000)
  })
  const report = runDecayJob(store, claimDecay(store), now)
  assert.equal(report.revived, 1)
  assert.equal((await service.recall({ query: 'hibernating' }, principal)).hits.length, 1)
  registry.dispose()
  cleanup(root)
})

test('decay leaves evidence entirely alone: the quote outlives any age', async () => {
  // Replaces 'decay: excerpts compact but refs survive'. That test asserted the
  // 30-day `EXCERPT_COMPACT_MS` rule, which is DELETED: once `service.source`
  // reads `evidence.excerpt` as its primary evidence path, nulling it stops
  // being "drop an unread column" and becomes "destroy the proof D3 promises".
  //
  // The old test's second assertion is kept and STRENGTHENED rather than
  // dropped, because it carried independent value that no other test covers:
  // `extract.ts`'s source suppression looks tombstoned memories up by
  // `evidence.ref`, and only this test watched decay leave that ref alone.
  // (`service.test.mjs` checks `forget` keeps the ref; nothing else checked
  // decay.) Its assertion is now the stronger one the deletion licenses: decay
  // must not modify the evidence row AT ALL.
  //
  // Ages are deliberately absurd — 200 days is past every window this codebase
  // has ever had, including the 90-day L0 retention — so the test states "no
  // finite age compacts an excerpt" rather than pinning a specific threshold
  // that a future constant could quietly slip under.
  const { root, registry, principal, service } = setup()
  const { store, id, excerpt } = await memoryWithExcerpt(
    service,
    principal,
    'sess-9',
    [userMessageEvent('the exact words an auditor will want')],
    [2],
  )
  assert.ok(excerpt, 'the real writer stored a quotation to begin with')
  const before = store.db.prepare(`SELECT ref, excerpt FROM evidence WHERE memory_id = ?`).get(id)
  // Age the memory far past every retention window in the system.
  store.db
    .prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`)
    .run(Date.now() - 200 * 86_400_000, id)

  runDecayJob(store, claimDecay(store), Date.now())

  const after = store.db.prepare(`SELECT ref, excerpt FROM evidence WHERE memory_id = ?`).get(id)
  assert.equal(after.excerpt, before.excerpt, 'the quote does NOT age out — it is the evidence')
  assert.equal(after.ref, before.ref, 'the ref never does — source suppression depends on it')
  // The end-to-end consequence, which is what actually regressed: the audit
  // path still answers after the memory has sat untouched for 200 days.
  const turns = await service.source(id, principal, SOURCE_TURN_LIMIT)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, excerpt, 'sourceOf still shows the cited words after decay ran')
  registry.dispose()
  cleanup(root)
})

/**
 * T2 — the schema v11 invariant, over the STATUS ENUM rather than a list.
 *
 * v4 wrote "a derived layer is regenerated wholesale, never aged out row by
 * row" in a comment and enforced `status = 'dormant'` alone. Measured against
 * v10, that covered 1 of the 5 non-active statuses; `candidate`, `superseded`,
 * `archived` and `tombstone` were all ACCEPTED on a derived row. This test is
 * the comment's actual claim.
 *
 * The expectation is DERIVED from `MEMORY_STATUSES`, never a written-out list
 * of five: a status added later must be covered by this test the day it is
 * added, without anyone remembering to come back here. Same reason the v10
 * test loops over `PROVENANCES` and `DERIVED_LAYERS`.
 */
test('a derived row can never leave active — every non-active status, every layer', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  const nonActive = MEMORY_STATUSES.filter((s) => s !== 'active')
  assert.ok(nonActive.length > 0, 'the enum must actually offer non-active statuses')

  for (const layer of DERIVED_LAYERS) {
    const id = `roll-${layer}`
    // Written directly rather than through the rebuild job because the point is
    // the DATA constraint: any writer producing this row must be refused.
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
           VALUES (?,'fact','repo-local','active','rollup','body',?,0,0,?)`,
        )
        .run(id, DERIVED_PROVENANCE, layer)
    })
    for (const status of nonActive) {
      assert.throws(
        () => store.db.prepare(`UPDATE memories SET status = ? WHERE id = ?`).run(status, id),
        /cannot leave active/,
        `a derived row at layer ${layer} must not be movable to '${status}'`,
      )
    }
    // Still there, still active: a refusal, not a silent deletion. Without this
    // the test would also pass if the guard destroyed the row it was asked to
    // protect — which is exactly what the missing `OF derived` column does on
    // the promotion route below.
    const kept = store.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
    assert.equal(
      kept?.status,
      'active',
      `the derived row survives every refused transition at layer ${layer}`,
    )
    assert.equal(kept?.derived, layer, `and stays at layer ${layer}`)
    store.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
  }

  // The second route into the same forbidden state: promote an ALREADY
  // non-active RAW row INTO the layer, arriving through the `derived` column
  // instead of the `status` one. This is what the trigger's `OF derived`
  // column list buys, and dropping it is not cosmetic — the promotion is then
  // accepted and D9's `invalidate_derived_update` deletes the row inside the
  // same statement, so the failure mode is silent data loss rather than a
  // refusal. Asserting the row SURVIVES is what makes that observable.
  for (const status of nonActive) {
    const id = `promote-${status}`
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
           VALUES (?,'fact','repo-local',?,'t','b','human',0,0,?)`,
        )
        .run(id, status, LAYER.RAW)
    })
    assert.throws(
      () =>
        store.db
          .prepare(`UPDATE memories SET derived = ?, provenance = ? WHERE id = ?`)
          .run(LAYER.SCENARIO, DERIVED_PROVENANCE, id),
      /cannot leave active/,
      `a '${status}' row must not be promotable into the derived layer`,
    )
    const survivor = store.db.prepare(`SELECT status, derived FROM memories WHERE id = ?`).get(id)
    assert.equal(
      survivor?.status,
      status,
      `the refused row is still THERE — the guard must not delete what it rejects`,
    )
    assert.equal(survivor?.derived, LAYER.RAW, 'and was not promoted into the layer')
  }

  // The third route: born non-active. No writer emits this today (rebuild
  // hardcodes 'active'), so it is guarded over the data rather than over the
  // transitions — the D9 lesson about writers not yet written.
  for (const layer of DERIVED_LAYERS) {
    for (const status of nonActive) {
      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
               VALUES (?,'fact','repo-local',?,'t','b',?,0,0,?)`,
            )
            .run(`born-${layer}-${status}`, status, DERIVED_PROVENANCE, layer),
        /must be born active/,
        `a derived row must not be INSERTable at '${status}' (layer ${layer})`,
      )
    }
  }

  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != ? AND status != 'active'`)
      .get(LAYER.RAW).c,
    0,
    'the sentence the injection read path is now entitled to assume',
  )
  registry.dispose()
  cleanup(root)
})

/**
 * T3 — reverse discrimination. The guard must bound the DERIVED layer, not
 * freeze the status column: decay writes `dormant`, reconcile writes
 * `superseded`/`archived` and `forget` writes `tombstone`, all on RAW rows, and
 * an over-broad trigger would break the entire lifecycle while still passing
 * T2. Dropping `AND new.derived != LAYER.RAW` is the mutant this traps.
 */
test('a RAW row still moves to every status — the guard bounds the layer, not the column', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
         VALUES ('raw','fact','repo-local','active','t','b','human',0,0,?)`,
      )
      .run(LAYER.RAW)
  })
  for (const status of MEMORY_STATUSES) {
    store.db.prepare(`UPDATE memories SET status = ? WHERE id = 'raw'`).run(status)
    assert.equal(
      store.db.prepare(`SELECT status FROM memories WHERE id = 'raw'`).get().status,
      status,
      `a raw row must still be movable to '${status}'`,
    )
  }
  // And INSERTable at every status, which is the same rule on the third
  // execution point: `extract.ts` writes 'candidate' rows through it.
  for (const status of MEMORY_STATUSES) {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
         VALUES (?,'fact','repo-local',?,'t','b','human',0,0,?)`,
      )
      .run(`ins-${status}`, status, LAYER.RAW)
  }
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories`).get().c,
    MEMORY_STATUSES.length + 1,
    'every raw INSERT landed',
  )
  registry.dispose()
  cleanup(root)
})

// ------------------------------------------------ derived layer ----------

/** Fill a store past the injection budget so the rollup path engages. */
const overflow = async (service, principal, n = 60) => {
  for (let i = 0; i < n; i++) {
    await service.propose(
      {
        title: `fact number ${i} about the system`,
        body: `a reasonably long body describing detail ${i}. `.repeat(6),
        kind: 'fact',
      },
      principal,
    )
  }
}

/**
 * A rollup reply. The job now expects scenario blocks as strict JSON, so a
 * bare string is sugar for "one scenario with this body"; pass an array of
 * {title, body} to exercise several.
 */
const rollupReply = (reply) => {
  const scenarios =
    typeof reply === 'string' ? [{ title: 'General', body: reply }] : reply
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ scenarios }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('derived layer engages only on overflow and replaces the raw set', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  assert.equal(packetOverflows(store), false, 'an empty store does not overflow')

  await overflow(service, principal)
  assert.equal(packetOverflows(store), true, 'the measured packet exceeds budget')

  ctx.get = (name) => (name === 'llm' ? rollupReply('use pnpm; deploy with make; tests in vitest') : undefined)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: readRevision(store), provider: 'p', model: 'm' }, 0)
  const built = await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: readRevision(store), provider: 'p', model: 'm' },
    new AbortController().signal,
  )
  assert.equal(built, true)

  // Injection now carries the rollup INSTEAD of the raw entries.
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /use pnpm; deploy with make/)
  assert.doesNotMatch(packet, /fact number 3 about/, 'raw entries are replaced, not appended')
  assert.ok(estimateTokens(packet) <= INJECT_PACKET_BUDGET_TOKENS, 'and it fits the budget')
  registry.dispose()
  cleanup(root)
})

// ---------------------------------------- the trigger's CONTAINER rule ----
//
// The five tests below cover one rule stated in two places: `packetOverflows`
// prices `queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)` — the RAW set at the
// ROLLUP limit — and `runRebuildJob`'s arrival re-check must price THE SAME
// set at THE SAME limit. Three independent things can be got wrong there, and
// the tests are split along exactly those seams so a red test names the defect:
//
//   the CONTAINER  raw set vs `queryInjectionRows`   T1 (enqueue) T5 (re-check)
//   the LIMIT      200 vs INJECT_TOP_N (20)          T1 (enqueue) T5 (re-check)
//   the OPERATOR   `>` vs `>=`                       T4
//   the AGREEMENT  both sides answer from one set    T3
//   NON-SELF-REFERENCE, by dimension — the two are NOT the same claim:
//     it never SELECTS its own output                T2, T3
//     it never lets that output discount the PRICE   T6
//
// Two fixtures do the discriminating, and which one a test uses IS its
// argument:
//
//   `overflow` (existing, 60 LARGE rows)  full set 4660 tok, window 1560 tok.
//       BOTH containers overflow, so this fixture cannot separate them — but
//       once a rollup exists it separates them completely, because
//       `queryInjectionRows` then returns the summary alone (6 tok).
//   `narrowWindowOverflow` (70 SMALL rows) full set 1330 tok, window 380 tok,
//       budget 1300, and NO derived layer. Here the window fits and the full
//       set does not, so it separates the container and the limit with no
//       rollup anywhere in the picture.
//
// All figures above are measured by the assertions themselves, never asserted
// as literals: the tests re-derive them from the production `renderEntry` /
// `estimateTokens`, so a change to how a row is priced moves the fixture
// instead of silently invalidating it.

/**
 * Many SMALL rows: the top-20 injection window fits the budget while the full
 * `ROLLUP_SOURCE_LIMIT` set does not. Deliberately builds NO derived layer,
 * which is what makes it a clean probe of the container and the limit — with
 * no rollup in the store, `queryInjectionRows` degrades to
 * `queryInjectableSet(store, INJECT_TOP_N)`, so it differs from the production
 * container by the LIMIT alone and self-reference cannot be the explanation.
 *
 * KEEP THE ROWS EQUALLY PRICED. `updated_at` collides heavily at this write
 * rate (70 rows land on 26 distinct timestamps), so `ORDER BY priority,
 * updated_at DESC` does not determine WHICH rows fall inside the top-20
 * window. That is harmless only because every row costs the same: sampled 200
 * times, the window prices 380 and the full set 1330, every time. Give these
 * rows differing sizes and the window's total becomes sampling-dependent —
 * a real flake, and one an earlier draft of these tests actually had (an
 * assertion on which row landed in the window failed 2 runs in 3). Assert on
 * PRICES here, never on which row is where.
 */
const narrowWindowOverflow = async (service, principal, n = 70) => {
  for (let i = 0; i < n; i++) {
    await service.propose(
      { title: `title ${i}`, body: `${'word '.repeat(10)}end ${i}`, kind: 'fact' },
      principal,
    )
  }
}

/** ctx serving both the rollup reply and the route the enqueue side pins. */
const routedLlm = (ctx, body) => {
  ctx.get = (name) =>
    name === 'llm'
      ? rollupReply(body)
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined
}

const derivedBody = (store) =>
  store.db.prepare(`SELECT body FROM memories WHERE derived != 0 AND status = 'active' LIMIT 1`)
    .get()?.body

/** One full trigger→claim→execute cycle through the REAL entry points. */
const rebuildOnce = async (ctx, store, body) => {
  routedLlm(ctx, body)
  const queued = enqueueRebuildIfOverflowing(ctx, store, Date.now())
  if (!queued) return { queued, built: false }
  const job = claimNextJob(store, Date.now(), Date.now() + 60_000)
  if (job === undefined) return { queued, built: false }
  const built = await runRebuildJob(
    ctx, store, job, JSON.parse(job.payload), new AbortController().signal,
  )
  return { queued, built }
}

test('T1: the trigger prices the WHOLE source set, not the window injection carries', async () => {
  // PINS: the enqueue-side container is the RAW set at ROLLUP_SOURCE_LIMIT.
  // RED UNDER: swapping the container to `queryInjectionRows` (M1), or the
  // limit to `INJECT_TOP_N` (M3) — both then price 380 tok against a 1300
  // budget and the store that genuinely needs summarizing is never queued.
  // GREEN UNDER: the pure self-referential mutant `hasDerivedLayer ?
  // queryInjectionRows : queryInjectableSet` (M8), which on this fixture takes
  // the raw branch and behaves exactly like HEAD. That is not a gap in this
  // test — it is the division of labour: this is the enqueue-side LIMIT probe,
  // while T2/T3 are the ONLY two that kill M8, and a fixture that confounded
  // the two concerns would let both defects hide behind one another.
  //
  // "Only" is exact for M8, and that is the claim this split rests on. It is
  // NOT a claim that each mutant dies exactly once: M3 also reddens T4 and T5
  // (measured). Overlap is harmless — what the matrix has to show is that no
  // mutant survives, and that M8's two killers are not redundant with T1/T5.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await narrowWindowOverflow(service, principal)

  // The fixture's whole claim, measured rather than asserted as a constant:
  // the two candidate containers disagree, and they straddle the budget.
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c, 0,
    'precondition: no derived layer, so what follows measures the LIMIT, not the layer',
  )
  const windowTokens = packetTokens(queryInjectableSet(store, INJECT_TOP_N))
  const sourceTokens = packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT))
  assert.ok(windowTokens <= INJECT_BODY_BUDGET_TOKENS, 'precondition: the window fits the budget')
  assert.ok(sourceTokens > INJECT_BODY_BUDGET_TOKENS, 'precondition: the whole source set does not')
  // With no rollup stored, this is literally the M1 mutant's reading.
  assert.equal(
    packetTokens(queryInjectionRows(store)), windowTokens,
    'precondition: with no layer, `queryInjectionRows` IS the 20-row window',
  )

  assert.equal(packetOverflows(store), true, 'the set a rollup would consume overflows')
  const { queued, built } = await rebuildOnce(ctx, store, 'THE-ROLLUP')
  assert.equal(queued, true, 'so a rebuild is queued')
  assert.equal(built, true, 'and the job that arrives agrees there is work')
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /THE-ROLLUP/, 'and the packet now carries the summary')
  assert.doesNotMatch(packet, /end \d+/, 'in place of the raw rows it was built from')
  registry.dispose()
  cleanup(root)
})

test('T2: a store that already holds a derived layer keeps rebuilding it', async () => {
  // PINS: the trigger does not SELECT its own output — it reads the material,
  // not the summary. This is the state no other test in this file reaches: a
  // derived layer ALIVE while the raw set still overflows.
  //
  // Scope, stated exactly, because the wider claim is false: this pins the
  // SELECTION of rows. A mutant that keeps the right query and instead lets the
  // layer's size discount the PRICE (`raw - blocks * 200 > budget`) is
  // self-reference in the other dimension, and this fixture cannot see it —
  // at raw = 4660 it would take 17 blocks to change the verdict, and the writer
  // caps at ROLLUP_MAX_SCENARIOS = 6, so the state is unreachable here. T6
  // covers that dimension on the cheaper fixture, where one block suffices.
  // RED UNDER: M8 (`hasDerivedLayer ? queryInjectionRows : queryInjectableSet`),
  // M1 and M5 — with a rollup stored these price the summary (6 tok), answer
  // "no", and the layer freezes at GEN-1 while the raw set it describes moves
  // on.
  //
  // Honest about the overlap, since the matrix was actually run: T6 reddens
  // under every mutant this test does, and no measured mutant is caught here
  // and missed there. So T2/T3 are NOT justified by the mutant set — they are
  // kept because they assert a different proposition (which rows are read, and
  // that the two sides read the same ones) whose failure modes have not all
  // been enumerated. Do not read the matrix as proof that they earn their
  // place; read it as proof that T6 is the one that cannot be removed.
  // NOT REDUNDANT WITH T3: T3 proves the two SIDES agree in one pass; this
  // proves the answer does not decay ACROSS generations, which is the shape a
  // self-reference actually takes in production.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  assert.equal((await rebuildOnce(ctx, store, 'GEN-1')).built, true, 'bootstrap rollup')
  assert.equal(derivedBody(store), 'GEN-1')

  // The discriminating state. Note there is NO raw write in this loop: D9
  // deletes every derived row on any authoritative raw write, so a fixture
  // that grew the raw set would destroy the very layer under test and the
  // self-referential mutant would be indistinguishable from HEAD.
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c, 1,
    'precondition: the layer exists, so a self-referential trigger would read ITS size',
  )
  assert.ok(
    packetTokens(queryInjectionRows(store)) <= INJECT_BODY_BUDGET_TOKENS,
    'precondition: and that size is comfortably under budget — it would answer "no"',
  )
  for (let pass = 2; pass <= 4; pass++) {
    // With no raw write the revision never moves, so the idempotence key would
    // absorb the retrigger as a duplicate of the job that already ran. Pruning
    // the settled row is what `cleanupJobs` does to a `done` job past
    // DONE_RETENTION_MS in production; doing it here is what lets the trigger
    // be asked a second time about an unchanged snapshot.
    cleanupJobs(store, Date.now() + DONE_RETENTION_MS + 1)
    const result = await rebuildOnce(ctx, store, `GEN-${pass}`)
    assert.equal(result.queued, true, `pass ${pass}: the raw set still overflows, so work is queued`)
    assert.equal(result.built, true, `pass ${pass}: and the arriving job finds work to do`)
    assert.equal(derivedBody(store), `GEN-${pass}`, `pass ${pass}: the layer was actually replaced`)
  }
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /GEN-4/, 'the packet carries the newest summary')
  assert.doesNotMatch(packet, /GEN-1/, 'and not the generation it would have frozen at')
  registry.dispose()
  cleanup(root)
})

test('T3: enqueue and the arrival re-check answer from ONE set', async () => {
  // PINS: the agreement itself. A job queued as necessary must not be
  // dismissed as unnecessary the moment it arrives — that pairing is a
  // livelock, queued and discarded forever at one LLM-free round trip apiece.
  // RED UNDER: M8 and M1 (the enqueue side goes quiet, so `queued` is false)
  // and M5 (the enqueue side still fires but the re-check prices the 6-token
  // summary and drops the job).
  // NOT REDUNDANT WITH T2: T2 watches generations advance and would still pass
  // if BOTH sides were changed together in a way that stayed consistent; this
  // one holds the two sides against each other within a single pass, which is
  // the property `packetOverflows`' comment actually states.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  assert.equal((await rebuildOnce(ctx, store, 'GEN-1')).built, true, 'bootstrap rollup')

  cleanupJobs(store, Date.now() + DONE_RETENTION_MS + 1)
  routedLlm(ctx, 'GEN-2')
  const queued = enqueueRebuildIfOverflowing(ctx, store, Date.now())
  assert.equal(queued, true, 'the enqueue side says there is work')
  const job = claimNextJob(store, Date.now(), Date.now() + 60_000)
  assert.notEqual(job, undefined, 'the job is claimable')
  // Without this the next assertion could be satisfied — or defeated — by the
  // revision fence rather than by the container rule under test.
  assert.equal(
    readRevision(store), JSON.parse(job.payload).expectedRevision,
    'and it is not fenced, so what follows is the re-check and nothing else',
  )
  const built = await runRebuildJob(
    ctx, store, job, JSON.parse(job.payload), new AbortController().signal,
  )
  assert.equal(built, true, 'so the arrival must not answer "unnecessary"')
  assert.equal(derivedBody(store), 'GEN-2', 'and the rollup it was queued to build exists')
  registry.dispose()
  cleanup(root)
})

test('T4: a set priced exactly AT the budget does not overflow', async () => {
  // PINS: the comparison is `>`, not `>=` — the ONLY test that catches M4.
  //
  // It is not the only mutant it reddens, and saying so precisely matters: the
  // flip step below stores 27 rows at 50 tok each, so a mutant reading the
  // 20-row window prices them at 1000 <= 1300 and the final assertion fails.
  // M1 and M3 therefore redden this test too (measured). That is incidental
  // coverage, not this test's job — read the exclusivity claim as "M4 dies
  // here and nowhere else", never as "only M4 reddens this test".
  // The token count is DERIVED from the production estimator against the
  // production renderer, never written down: a hardcoded 1300 would keep
  // passing while silently ceasing to sit on the boundary the day either
  // changes, which is the failure mode a boundary test exists to prevent.
  const { root, registry, principal, service } = setup()
  const store = service.storeFor(principal, true)

  // A row shape whose RENDERED cost divides the budget exactly, so the set can
  // land ON the boundary rather than merely near it.
  const entry = { kind: 'fact', title: 't', body: `${'word '.repeat(37)}x` }
  const perRow = estimateTokens(renderEntry({ id: '', ...entry }, false))
  const rows = INJECT_BODY_BUDGET_TOKENS / perRow
  assert.ok(
    Number.isInteger(rows) && rows <= ROLLUP_SOURCE_LIMIT,
    `precondition: ${perRow} tok/row divides the budget within the source limit`,
  )
  for (let i = 0; i < rows; i++) await service.propose({ ...entry }, principal)

  const priced = () => packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT))
  assert.equal(priced(), INJECT_BODY_BUDGET_TOKENS, 'the set sits exactly on the budget')
  assert.equal(packetOverflows(store), false, 'exactly at the budget is within it, not over it')

  // The other half, and it is not decoration: the assertion above holds just
  // as well for a trigger that never fires at all, so on its own it certifies
  // nothing. One row past the boundary must flip it.
  await service.propose({ ...entry }, principal)
  assert.ok(priced() > INJECT_BODY_BUDGET_TOKENS, 'one row past the boundary is over budget')
  assert.equal(packetOverflows(store), true, 'and only then does the trigger fire')
  registry.dispose()
  cleanup(root)
})

test('T5: the arrival re-check summarizes the WHOLE source set too', async () => {
  // PINS: the re-check's container AND limit, which T3 cannot separate (on its
  // fixture both containers overflow before a rollup exists). Here the 20-row
  // window fits and the full source set does not, so a re-check reading either
  // the wrong container or the wrong limit answers "no work" and settles a job
  // the enqueue side correctly raised.
  // RED UNDER: M5 (container) and M6 (limit). With no derived layer in this
  // store the two mutants read the same 380 tokens — which is exactly why one
  // fixture kills both, and why T3 is still needed for the case where a layer
  // exists and only the container is wrong.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await narrowWindowOverflow(service, principal)

  routedLlm(ctx, 'GEN-1')
  const queued = enqueueRebuildIfOverflowing(ctx, store, Date.now())
  assert.equal(queued, true, 'precondition: the enqueue side sees an overflowing source set')
  const job = claimNextJob(store, Date.now(), Date.now() + 60_000)
  assert.notEqual(job, undefined, 'precondition: the job is claimable')
  const built = await runRebuildJob(
    ctx, store, job, JSON.parse(job.payload), new AbortController().signal,
  )
  assert.equal(built, true, 'the arrival must not dismiss a job the enqueue side found necessary')
  assert.equal(derivedBody(store), 'GEN-1', 'and the rollup it was queued to build exists')
  registry.dispose()
  cleanup(root)
})

test('T6: a live derived layer does not discount the price of the set it summarizes', async () => {
  // PINS: the OTHER self-reference. T2/T3 pin which rows the trigger SELECTS;
  // this pins that the layer's existence does not make the material look
  // cheaper. Both are "the trigger must not price its own output", and a
  // mutant can satisfy either one while breaking the other:
  //
  //     raw - blocks * 200 > INJECT_BODY_BUDGET_TOKENS
  //
  // reads the correct query with the correct limit, keeps both sides in
  // agreement, and still freezes the layer. On the live stores it flips two of
  // the three that hold a derived layer, and before this test existed the whole
  // suite stayed green on it — T1..T5 all survived it. It is now the ONLY test
  // that catches it (measured), which is the same relationship T4 has to the
  // `>=` mutant: a single-point cover, deliberately recorded as such.
  //
  // THE FIXTURE IS THE ARGUMENT, and it must be the cheap one. T2's `overflow`
  // set prices 4660, so discounting it under 1300 would take 17 blocks while
  // the writer caps at ROLLUP_MAX_SCENARIOS (6) — structurally unreachable, so
  // T2 could never have caught this however it was written. Here the set
  // prices 1330 against a 1300 budget, and ONE block is enough. The margin is
  // asserted below rather than assumed, so a change to how rows are priced
  // fails loudly instead of quietly making this test vacuous.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await narrowWindowOverflow(service, principal)
  assert.equal((await rebuildOnce(ctx, store, 'GEN-1')).built, true, 'bootstrap rollup')

  const blocks = store.db
    .prepare(`SELECT count(*) c FROM memories WHERE derived != 0 AND status = 'active'`)
    .get().c
  assert.ok(blocks >= 1, 'precondition: a derived layer is live, so a discount would have something to subtract')
  const raw = packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT))
  assert.ok(
    raw > INJECT_BODY_BUDGET_TOKENS &&
      raw - blocks * INJECT_BODY_BUDGET_TOKENS <= INJECT_BODY_BUDGET_TOKENS,
    'precondition: the raw set overflows, but by little enough that one block of credit would hide it',
  )

  // No raw write in between, so the snapshot — and therefore the answer — must
  // not have moved. Pruning the settled row is only what lets the question be
  // asked a second time; see T2.
  cleanupJobs(store, Date.now() + DONE_RETENTION_MS + 1)
  assert.equal(
    packetOverflows(store), true,
    'the RAW set still overflows; a live layer must not discount the price of what it summarizes',
  )
  const again = await rebuildOnce(ctx, store, 'GEN-2')
  assert.equal(again.queued, true, 'so the work is queued again')
  assert.equal(again.built, true, 'and the arriving job agrees')
  assert.equal(derivedBody(store), 'GEN-2', 'and the layer advanced instead of freezing')
  registry.dispose()
  cleanup(root)
})

test('any authoritative write retires the rollup and bumps the revision', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('summary text') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c, 1)

  // One more save invalidates it.
  await service.propose({ title: 'new thing', body: 'changes the set', kind: 'fact' }, principal)
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c,
    0,
    'the summary built from the old snapshot is gone',
  )
  assert.ok(readRevision(store) > rev, 'and the revision advanced')
  registry.dispose()
  cleanup(root)
})

test('a PIPELINE write retires the rollup too, not just a tool write', async () => {
  // Regression. Invalidation used to hang off `commitL1Mutation` — the TOOL
  // write entry — while the pipeline commits through `commitClaimedJob`. So
  // reconcile (candidate ⇒ active) and decay (active ⇒ dormant) changed the
  // authoritative set while the summary built from the OLD set kept shadowing
  // it on the read path: a freshly learned fact stayed invisible behind a
  // stale rollup. It could not self-heal either — the rebuild job's
  // idempotence key is the revision, so with the revision frozen the retry was
  // absorbed as a duplicate of the job that already ran.
  //
  // Schema v5 states the rule over the DATA, so this holds for any write path,
  // including ones added later. Committing through the raw job entry here is
  // the point: it proves the guarantee does not depend on the caller.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('OLD SUMMARY: repo uses npm') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c, 1)
  const afterRollup = readRevision(store)

  // A reconcile-shaped commit: flip a candidate to active through the JOB
  // entry, which never knew about invalidation.
  const now = Date.now()
  store.tx(() => {
    store.db.prepare(
      `INSERT INTO jobs (id,kind,payload,state,attempts,run_after,created_at,lease_token)
       VALUES ('rc1','reconcile','{}','running',1,?,?,'tok')`).run(now, now)
    store.db.prepare(
      `INSERT INTO memories (id,kind,visibility,status,title,body,provenance,created_at,updated_at)
       VALUES ('m-new','fact','repo-local','candidate','uses pnpm','THE REPO NOW USES PNPM','human',?,?)`,
    ).run(now, now)
  })
  commitClaimedJob(store, 'rc1', 'tok', () => {
    store.db.prepare(`UPDATE memories SET status='active' WHERE id='m-new'`).run()
  })

  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c,
    0,
    'a pipeline write must retire the summary built from the old snapshot',
  )
  assert.ok(readRevision(store) > afterRollup, 'and it must advance the revision')
  // The newly learned fact is now actually reachable on the read path.
  assert.ok(
    queryInjectionRows(store).some((hit) => hit.body.includes('PNPM')),
    'the fresh fact is no longer hidden behind a stale summary',
  )
  registry.dispose()
  cleanup(root)
})

test('L2: a rebuild emits scenario blocks, and they vanish with their L1 (D9)', async () => {
  // The two acceptance criteria for 4x4 phase 2 (docs/design/4x4-memory.md §5).
  // A scenario block is an ordinary row at `derived = LAYER.SCENARIO`, so it
  // inherits D9 without a single line of new invalidation code — that
  // inheritance is the whole reason the layer is a widened column rather than
  // a new table.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)

  ctx.get = (name) =>
    name === 'llm'
      ? rollupReply([
          { title: 'Auth refactor', body: 'tokens now rotate on refresh; see auth/*' },
          { title: 'CI and release', body: 'tag, build, publish; never npm, always pnpm' },
        ])
      : undefined
  const rev0 = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb-l2', { expectedRevision: rev0, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev0, provider: 'p', model: 'm' }, new AbortController().signal,
  )

  // 1) Several blocks, each its own row at the scenario layer — not one summary.
  const blocks = store.db
    .prepare(`SELECT title, derived FROM memories WHERE derived != 0 ORDER BY title`)
    .all()
  assert.deepEqual(blocks.map((b) => b.title), ['Auth refactor', 'CI and release'])
  assert.deepEqual([...new Set(blocks.map((b) => b.derived))], [2], 'stored at LAYER.SCENARIO')

  // Injection carries the scenarios instead of the raw set, within budget.
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /Auth refactor/)
  assert.match(packet, /CI and release/)
  assert.doesNotMatch(packet, /fact number 3 about/, 'raw entries are replaced')
  assert.ok(estimateTokens(packet) <= INJECT_PACKET_BUDGET_TOKENS)

  // 2) One authoritative write to the RAW layer retires every block — no new
  // invalidation path was written for L2; it rides the v5 triggers.
  await service.propose(
    { title: 'a new fact', body: 'changes the set the blocks summarized', kind: 'fact' },
    principal,
  )
  assert.equal(
    store.db.prepare(`SELECT count(*) c FROM memories WHERE derived != 0`).get().c,
    0,
    'every scenario block goes when the set it described changes',
  )
  assert.ok(readRevision(store) > rev0, 'and the revision advanced, fencing a queued rebuild')
  registry.dispose()
  cleanup(root)
})

test('metrics price the container injection READS, and the repo side takes no cap', async () => {
  // Two halves of one rule, and the second half is why this fixture is not a
  // single small block. A summary REPLACES the raw set it summarizes, so the
  // metric must price the derived rows (half one) — and it must price them
  // WHOLE, because the personal-side cap belongs to the personal store alone
  // (half two). A fixture with one cheap block cannot see half two: any cap
  // large enough to be plausible leaves one cheap block untouched, so the test
  // passes whether or not the cap is wrongly applied here.
  //
  // So the blocks are written at the maximum the write path admits
  // (`ROLLUP_MAX_SCENARIOS` of them, each at `ROLLUP_TITLE_TARGET_CHARS` /
  // `ROLLUP_TARGET_CHARS`), which puts EVERY block above `worstPersonaTokens()`
  // individually. A cap misapplied to this store therefore skips all of them
  // and the value collapses to zero — the shape that let a mutation destroy
  // 8 of 9 live stores' numbers, one of them to zero, with nothing red.
  //
  // Both expectations are computed by the production functions rather than
  // written down: hard-coding either would lock in today's fixture instead of
  // the rule.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)

  const rawPrice = packetTokens(queryInjectableSet(store, INJECT_TOP_N))
  const fat = (n) => ({
    title: `scenario ${n} `.padEnd(ROLLUP_TITLE_TARGET_CHARS, 'x'),
    body: `the ${n}th scenario block, written at the enforced maximum. `.padEnd(
      ROLLUP_TARGET_CHARS,
      'x',
    ),
  })
  ctx.get = (name) =>
    name === 'llm'
      ? rollupReply(Array.from({ length: ROLLUP_MAX_SCENARIOS }, (_, i) => fat(i)))
      : undefined
  const rev0 = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb-metrics', { expectedRevision: rev0, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev0, provider: 'p', model: 'm' }, new AbortController().signal,
  )

  const derived = queryInjectionRows(store)
  assert.equal(derived.length, ROLLUP_MAX_SCENARIOS, 'precondition: a full derived layer')
  assert.ok(
    derived.every((hit) => packetTokens([hit]) > worstPersonaTokens()),
    'precondition: every block outprices the personal cap, so a wrong cap would zero this',
  )

  const m = collectMetrics(store, Date.now())
  // Half one: the container is the derived rows, not the set they replaced.
  assert.equal(m.injectableTokens, packetTokens(derived), 'the metric prices what is offered')
  assert.notEqual(m.injectableTokens, rawPrice, 'and not the set the summary replaced')
  // Half two: uncapped on this side. Stated against the capped alternative so
  // the assertion fails if the personal ceiling is ever applied here.
  assert.notEqual(
    packetTokens(withinBudget(derived, worstPersonaTokens())),
    packetTokens(derived),
    'precondition: the two alternatives are distinguishable on this fixture',
  )
  assert.notEqual(
    m.injectableTokens,
    packetTokens(withinBudget(derived, worstPersonaTokens())),
    'the repo side is NOT held to the personal store ceiling',
  )
  registry.dispose()
  cleanup(root)
})

test('the global metric is capped by the same bound injection caps personal with', async () => {
  // D9's triggers delete the L3 portrait on ANY personal raw write, and
  // `queryInjectionRows` then falls back to raw atoms bounded in COUNT only.
  // `buildContextProvider` caps that fallback at `worstPersonaTokens()` — the
  // cost of the portrait it stands in for — so an uncapped metric would report
  // tokens the packet never carries (34.1x on the live global store).
  //
  // The rows are deliberately UNEQUAL in size, alternating one that cannot fit
  // beside a cheap one that can. `withinBudget` skips an entry that does not
  // fit and keeps going (`render.ts`: priority order means one fat row must not
  // hide the cheap rows behind it), and equal-sized rows never exercise that:
  // with uniform costs the loop degenerates into `slice(0, k)`, and a mutation
  // replacing the budget rule with exactly that slice passes unnoticed. Here
  // the kept set is provably not a prefix.
  const { root, registry, principal, service } = setup()
  const propose = (i, body) =>
    service.propose(
      { title: `preference number ${i} about how to work`, body, kind: 'preference', scope: 'personal' },
      principal,
    )
  for (let i = 0; i < 20; i++) {
    // Odd rows are individually larger than the whole cap; even rows are cheap.
    await propose(i, i % 2 === 1
      ? `a long statement of taste, number ${i}, that alone outprices the cap. `.repeat(12)
      : `terse taste ${i}.`)
  }
  const global = registry.get(GLOBAL_STORE_KEY)
  const rows = queryInjectionRows(global)
  const kept = withinBudget(rows, worstPersonaTokens())
  assert.ok(
    packetTokens(rows) > worstPersonaTokens(),
    'precondition: the uncapped personal fallback overruns the cap it is held to',
  )
  assert.ok(
    rows.some((hit) => packetTokens([hit]) > worstPersonaTokens()),
    'precondition: at least one row cannot fit the cap at all',
  )
  // The skip-not-stop property itself: what survives is NOT a prefix of what
  // was offered, so a `slice` cannot stand in for the budget rule.
  assert.notDeepEqual(
    kept.map((hit) => hit.id),
    rows.slice(0, kept.length).map((hit) => hit.id),
    'precondition: the budget skips over a fat row and keeps a later cheap one',
  )

  const m = collectMetrics(global, Date.now())
  assert.ok(
    m.injectableTokens <= worstPersonaTokens(),
    `personal is reported within its cap: ${m.injectableTokens} <= ${worstPersonaTokens()}`,
  )
  assert.equal(
    m.injectableTokens,
    packetTokens(kept),
    'and it is the runtime selection that is priced, by the same function',
  )
  registry.dispose()
  cleanup(root)
})

test('injectableTokens is a candidate price: the packet budget is NOT applied here', async () => {
  // The promise this field makes, pinned so the "obvious fix" cannot land
  // silently. A store CAN offer more than `INJECT_BODY_BUDGET_TOKENS`, and
  // this field reports that overrun rather than clamping it: the real packet
  // budget is spent on personal and repo rows CONCATENATED, inside
  // `renderFramed`, so a per-store clamp here would be a third implementation
  // of the selection rule and a different approximation — not a closer one.
  //
  // A mutation adding `withinBudget(injectable, INJECT_BODY_BUDGET_TOKENS)`
  // must therefore turn this RED. That is not a regression being caught; it is
  // a decision being enforced (ADR 0009: where the implementation is left
  // alone, the promise is what gets corrected — hence "injectable", not
  // "injected").
  const { root, registry, principal, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)

  const offered = queryInjectionRows(store)
  assert.ok(
    packetTokens(offered) > INJECT_BODY_BUDGET_TOKENS,
    'precondition: this store offers more than one packet can carry',
  )
  const m = collectMetrics(store, Date.now())
  assert.equal(m.injectableTokens, packetTokens(offered), 'the whole candidate set is priced')
  assert.ok(
    m.injectableTokens > INJECT_BODY_BUDGET_TOKENS,
    'exceeding the packet budget is reportable, not an anomaly to be clamped',
  )
  registry.dispose()
  cleanup(root)
})

/** A portrait reply: `true` keeps the stored one, a string rewrites it. */
const personaReply = (verdictOrBody) => {
  const payload =
    verdictOrBody === true ? { verdict: 'keep' } : { verdict: 'rewrite', body: verdictOrBody }
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** Drive one persona judgement against the global store. */
const judgePersona = async (ctx, global, llm, jobKey) => {
  ctx.get = (name) =>
    name === 'llm'
      ? llm
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined
  const rev = readRevision(global)
  enqueueJob(global, 'rebuild', jobKey, { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  const job = claimNextJob(global, Date.now(), Date.now() + 60_000)
  return runRebuildJob(
    ctx, global, job, JSON.parse(job.payload), new AbortController().signal,
  )
}

test('L3: the portrait is written once, and "keep" does not churn it', async () => {
  // The acceptance criteria for 4x4 phase 3 (docs/design/4x4-memory.md §5).
  // L3 must not wobble with every stored preference, which is why "keep" is a
  // real answer rather than an unconditional regeneration (ADR 0004): the
  // model judges, and a judgement of "still accurate" writes nothing at all.
  const { root, registry, principal, ctx, service } = setup()
  await service.propose(
    { title: 'answer in Chinese', body: 'the user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  await service.propose(
    { title: 'evidence first', body: 'claims must be backed by a measurement', kind: 'coding', scope: 'personal' },
    principal,
  )
  const global = registry.get(GLOBAL_STORE_KEY)

  // First pass: no portrait yet, so one is written.
  assert.equal(await judgePersona(ctx, global, personaReply('Chinese; conclusions first; wants evidence.'), 'pj1'), true)
  const stored = global.db.prepare(`SELECT title, kind, visibility, body FROM memories WHERE derived = 3`).all()
  assert.equal(stored.length, 1, 'exactly one portrait')
  assert.equal(stored[0].visibility, 'private', 'the portrait never leaves the cross-repo store')
  const revAfter = readRevision(global)

  // Second pass: judged still accurate => nothing written, nothing invalidated.
  assert.equal(await judgePersona(ctx, global, personaReply(true), 'pj2'), false)
  assert.equal(
    global.db.prepare(`SELECT body FROM memories WHERE derived = 3`).get().body,
    stored[0].body,
    'a "keep" verdict leaves the portrait byte-for-byte alone',
  )
  assert.equal(readRevision(global), revAfter, 'and does not advance the revision')

  // A rewrite replaces rather than accumulates.
  assert.equal(await judgePersona(ctx, global, personaReply('Now prefers English.'), 'pj3'), true)
  const after = global.db.prepare(`SELECT body FROM memories WHERE derived = 3`).all()
  assert.equal(after.length, 1, 'still exactly one portrait')
  assert.match(after[0].body, /English/)
  registry.dispose()
  cleanup(root)
})

/* ── L3 obeys §2.3: 注入资格随最低来源 ───────────────────────────────────────

   The portrait is not a read-only view of its sources. `runPersonaJob` stores
   the model's answer as an ordinary row stamped `DERIVED_PROVENANCE`, and
   `queryInjectionRows` prefers derived rows over the raw set — so whatever
   reaches the portrait prompt reaches EVERY repository's packet, with its
   provenance rewritten on the way. A source set wider than the packet's own
   would therefore launder `subagent` / `tool-output` rows into injected text
   past the §2.3 filter that exists to keep them out.

   Both call sites read `queryPersonaSources`, and both tests below are needed
   because they are NOT independent evidence of each other — each names the ONE
   line whose reversion turns it red, and neither turns red for the other's.
   Measured, one mutation at a time:

     revert `runPersonaJob`'s source query only  -> only test 1 goes red
     revert `enqueuePersonaRebuild`'s only       -> only test 2 goes red
     revert both (HEAD behaviour)                -> both go red
     keep the row set correct, but fold the
       low-trust BODIES into an admitted row     -> only test 1 goes red

   Deleting either test therefore lets its own side regress in silence, which is
   the half-applied paired fix ADR 0007 lesson 6 warns about — and here the
   halves fail DIFFERENTLY: the execution side leaks low-trust content into the
   prompt, the enqueue side leaks a `jobs` row per snapshot.

   The fourth row is why test 1 asserts on titles AND bodies. An earlier version
   checked titles only and stayed GREEN against that mutation, even though the
   leak it models is the real §2.3 failure: low-trust text in the prompt, stored
   back as `derived`, injected everywhere. A correct row set is not the property
   worth asserting — uncontaminated prompt bytes are. */

/**
 * The provenances §2.3 keeps out of injection, DERIVED from the two exported
 * tuples rather than spelled out.
 *
 * Writing `['subagent', 'tool-output']` here would be today's answer copied
 * into a fixture: `INJECTABLE_PROVENANCE` is the rule, and a provenance added
 * to `PROVENANCES` without being made injectable must widen this set by
 * itself. (STATUS.md item `l` records the same mistake made with a `kind`
 * literal, where the copied conclusion happened to still be right.)
 *
 * `DERIVED_PROVENANCE` is excluded because no production writer ever puts it on
 * a RAW row: the only two INSERTs that use it (`pipeline/rebuild.ts`) both write
 * a non-RAW layer, and the two that write RAW rows spell the provenance
 * `'principal-explicit'` (`service.ts`) or take it from `provenanceFor`
 * (`pipeline/extract.ts`), which reduces over event categories and can return
 * `subagent`/`tool-output`/`parent-agent`/`human` but has no branch producing
 * `'derived'`. Across the nine live stores (500 rows, no status filter) the
 * `derived = 0 AND provenance = 'derived'` cell measures 0 — the same count and
 * the same cell `schema.ts`'s `migrateV10` reports (it read 494 rows when it was
 * written; the six new rows are ordinary growth, and the cell is still 0).
 *
 * This is FIXTURE DISCIPLINE, not a schema guarantee, and the difference
 * matters enough to state: the v10 CHECK constrains ONE direction only
 * (`derived != RAW ⇒ provenance = 'derived'`) and does NOT forbid the converse.
 * Measured against a live store — inserting `derived = 0` with
 * `provenance = 'derived'` is ACCEPTED, while `derived = 3` with
 * `provenance = 'human'` is refused. `schema.ts`'s `migrateV10` says so itself
 * ("ONE DIRECTION ONLY, deliberately") and explains why the converse is safe to
 * leave writable: `'derived'` is not in `INJECTABLE_PROVENANCE`, so such a row
 * is excluded rather than injected.
 *
 * So the exclusion carries weight — without it `seedPersonal` would fabricate a
 * row the write path never produces, and both tests would assert against an
 * invented state — but it is enforced HERE, by this filter, and nowhere else.
 *
 * KNOWN LIMIT, left in place deliberately. The derivation splits `PROVENANCES`
 * into "injectable" and "everything else", and treats the second half as
 * SOURCES a store could hold. A future member that is a generator's stamp
 * rather than a source — a second `DERIVED_PROVENANCE`, say — would land in the
 * low-trust half and be seeded as though a writer produced it, making these
 * tests assert about a row that cannot exist. Naming that case here rather than
 * coding around it: any predicate for "is this a stamp?" would be a second
 * hand-maintained list, which is the duplication the derivation exists to
 * avoid, and it would go stale in exactly the same way.
 */
const NON_INJECTABLE_PROVENANCE = PROVENANCES.filter(
  (p) => p !== DERIVED_PROVENANCE && !INJECTABLE_PROVENANCE.includes(p),
)

/**
 * Insert one active RAW personal memory carrying a chosen provenance.
 *
 * Title and body carry SEPARATE markers on purpose. A row reaches the prompt
 * through two independent channels, and a leak can use either: dropping the
 * provenance filter carries both, while a defect that keeps the row set correct
 * and merely folds low-trust TEXT into an admitted row's body carries only the
 * second. Sharing one marker across both fields would collapse that distinction
 * and leave the body channel unasserted (measured — see the test below).
 */
const seedPersonal = (global, provenance) => {
  global.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'preference', 'private', 'active', ?, ?, ?, 0, 0, 0)`,
    )
    .run(randomUUID(), `TITLE-${provenance}`, `BODY-${provenance}`, provenance)
}

/** The rule `enqueuePersonaRebuild` used to apply: every active RAW row. */
const unfilteredSourceCount = (global) =>
  global.db.prepare(`SELECT count(*) n FROM memories WHERE status = 'active' AND derived = 0`)
    .get().n

/**
 * A portrait reply that also RECORDS what `llm.stream` was handed. The capture
 * is the whole options object serialized, not the rows some query returned:
 * the claim under test is about what the model is shown, so the assertion has
 * to sit on the last surface before the bytes leave the process.
 */
const capturingPersonaReply = (sink) => ({
  stream: async function* (options) {
    sink.seen = JSON.stringify({ system: options.system, messages: options.messages })
    yield {
      type: 'text-delta',
      index: 0,
      text: JSON.stringify({ verdict: 'rewrite', body: 'a portrait' }),
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('L3 sources: no low-trust title OR body appears in the portrait prompt bytes', async () => {
  // Reverting `runPersonaJob`'s source query to the hand-written
  // `WHERE status='active' AND derived = LAYER.RAW` turns this red, and the
  // enqueue-side test below stays green — the two halves are asserted apart on
  // purpose.
  //
  // Asserted on the bytes handed to `llm.stream`, not on what
  // `queryPersonaSources` returns: a test on the query would pass against a
  // correct query wired into nothing, which is precisely the state HEAD is in
  // for the other call site.
  //
  // ## What this assertion IS, stated at its real strength
  //
  // A SUBSTRING BLACKLIST over two channels — the low-trust rows' titles and
  // their bodies — and not the general property its name might suggest. The
  // name says "title OR body" rather than "never reaches the prompt" because
  // the weaker sentence is the one actually checked.
  //
  // Both channels are needed, and that is measured rather than assumed. A
  // mutation that leaves the ROW SET correct (the provenance filter fully
  // intact) and merely concatenates the non-injectable rows' bodies onto an
  // admitted row's body leaks exactly what §2.3 exists to stop — low-trust
  // CONTENT into the portrait prompt, thence into a `derived` row injected in
  // every repository — and against a title-only assertion it passed green.
  // Adding the body channel is what turns it red.
  //
  // Its limit is equally known, and it is wider than "re-encodes or
  // paraphrases" suggests. Four mutations that keep the ROW SET correct and
  // fold the low-trust bodies into an admitted row all pass 239/0 green:
  // reversing the characters, base64, inserting a zero-width space, and
  // CHOPPING ONE CHARACTER off each marker. The last one deserves the name:
  // it is not a rewrite at all — nearly the whole secret survives verbatim —
  // so "a substring check only catches verbatim substrings" is the honest
  // statement, not "it only misses paraphrases".
  //
  // Two channels ARE covered, and by construction rather than by luck: the
  // assertion reads the whole `llm.stream` options blob, so smuggling through
  // `kind` or through the system prompt turns it red (measured, 238/1 each).
  //
  // That is the same trade the truncation-mark test below documents —
  // an honest blacklist with its boundary written down beats an assertion that
  // claims a property and delivers a word list.
  const { root, registry, ctx } = setup()
  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()

  assert.ok(
    NON_INJECTABLE_PROVENANCE.length > 0,
    'precondition: §2.3 excludes at least one provenance, or this test asserts nothing',
  )
  global.tx(() => {
    for (const p of INJECTABLE_PROVENANCE) seedPersonal(global, p)
    for (const p of NON_INJECTABLE_PROVENANCE) seedPersonal(global, p)
  })
  // Precondition: the reverted rule and this one DISAGREE on this fixture. A
  // store of only injectable rows would go green under both, so without this
  // the test could be decoration and look identical.
  assert.equal(
    unfilteredSourceCount(global),
    INJECTABLE_PROVENANCE.length + NON_INJECTABLE_PROVENANCE.length,
    'precondition: the unfiltered rule would hand every one of these rows to the model',
  )

  const sink = {}
  assert.equal(await judgePersona(ctx, global, capturingPersonaReply(sink), 'pj-prov'), true)
  assert.ok(sink.seen !== undefined, 'precondition: the portrait job really did call the model')

  // Both channels, per provenance. `field` is named in the message because
  // "which one leaked" is the difference between a broken row filter and a
  // body-level contamination, and they have different fixes.
  for (const p of NON_INJECTABLE_PROVENANCE) {
    for (const [field, marker] of [
      ['title', `TITLE-${p}`],
      ['body', `BODY-${p}`],
    ]) {
      assert.ok(
        !sink.seen.includes(marker),
        `the ${field} of a '${p}' row reached the portrait prompt. The portrait is written ` +
          `back as '${DERIVED_PROVENANCE}' and injected in every repository, so anything ` +
          'admitted here is laundered past the §2.3 filter with no trace of where it came from',
      )
    }
  }
  // And the filter did not simply empty the prompt — the portrait still has
  // material, so this is a filter rather than a break. Asserted on both fields
  // as well, so that a mutation blanking bodies wholesale cannot pass by making
  // the negative assertions vacuously true.
  for (const p of INJECTABLE_PROVENANCE) {
    assert.ok(sink.seen.includes(`TITLE-${p}`), `an injectable '${p}' title is still portrayed`)
    assert.ok(sink.seen.includes(`BODY-${p}`), `an injectable '${p}' body is still portrayed`)
  }
  registry.dispose()
  cleanup(root)
})

test('L3 enqueue: a store holding only low-trust rows queues no portrait job, ever', async () => {
  // Reverting `enqueuePersonaRebuild` to its `count(*)` query turns this red,
  // and the prompt test above stays green.
  //
  // Asserted on the `jobs` table, because the damage is a PERSISTED one.
  // `packetOverflows`' comment states the rule this enforces at L3: enqueue and
  // execution must answer from one set, or a job is queued and then dismissed
  // as unnecessary on arrival. The idempotence key cannot absorb the repeat —
  // `store_revision` rides it, so every snapshot mints a fresh job id — which
  // turns "one wasted job" into one leaked row per revision, forever.
  const { root, registry } = openRegistry()
  const global = registry.openGlobal()
  const ctx = fakeCtx({
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
  })

  global.tx(() => {
    for (const p of NON_INJECTABLE_PROVENANCE) seedPersonal(global, p)
  })
  // Precondition: the store is NOT empty. Under the reverted rule this count is
  // what decides, so a value of 0 would make both implementations answer "do
  // not queue" and the test would prove nothing.
  assert.ok(
    unfilteredSourceCount(global) > 0,
    'precondition: an unfiltered count sees rows here, so the two rules differ on this fixture',
  )

  // Three snapshots, three distinct idempotence keys. One bump would not
  // distinguish "absorbed by the key" from "never queued".
  const bump = () =>
    global.db
      .prepare(
        `INSERT INTO meta (k, v) VALUES ('store_revision', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      )
      .run(String(readRevision(global) + 1))
  for (let pass = 0; pass < 3; pass++) {
    bump()
    assert.equal(
      enqueueRebuildIfOverflowing(ctx, global, Date.now()),
      false,
      `pass ${pass}: nothing here may be portrayed, so nothing may be queued to portray it`,
    )
  }
  assert.equal(
    global.db.prepare(`SELECT count(*) n FROM jobs WHERE kind = 'rebuild'`).get().n,
    0,
    'and no rebuild row accumulated — the leak is one row per revision, so it is counted here',
  )
  registry.dispose()
  cleanup(root)
})

/* ── The write path is bounded in the unit its container spends ─────────────

   Seven tests for one defect: the derived write path bounded CHARACTERS
   (`slice(0, ROLLUP_TARGET_CHARS)`) while the container that spends the rows
   prices RENDERED TOKENS, and `renderEntry` indents every `\n` by two
   characters. A fully compliant row could therefore be unaffordable, and
   `withinBudget` SKIPS what it cannot afford, so it was not shortened — it
   disappeared.

   Each test below names the ONE line whose reversion turns it red, because a
   test that would survive the bug is decoration. */

/** A body of `chars` characters carrying a line break every `every` characters. */
const dense = (chars, every) => {
  let body = ''
  for (let i = 0; i < chars; i++) body += (i + 1) % every === 0 ? '\n' : 'x'
  return body
}

test('L2 write path: a scenario block is bounded by rendered tokens, not characters', async () => {
  // Reverting `parseScenarios` to `.slice(0, ROLLUP_TARGET_CHARS)` turns this
  // red. The fixture is a block at exactly the CHARACTER target and a density
  // the character rule cannot see, so the two candidate implementations
  // disagree on it: `slice` passes it through whole (620 chars, over the
  // ceiling once rendered), the token cut trims it.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)

  const body = dense(ROLLUP_TARGET_CHARS, 3)
  // Precondition: the character rule would ADMIT this unchanged, and the row
  // it admits does not fit. Without this the test could pass against either
  // implementation and would be asserting nothing.
  assert.equal(body.length, ROLLUP_TARGET_CHARS, 'the fixture is exactly at the character target')
  assert.ok(
    estimateTokens(renderEntry({ id: '', kind: 'fact', title: 'Dense', body }, false)) >
      SCENARIO_MAX_TOKENS,
    'precondition: the character-legal body is over the token ceiling, so the rules differ here',
  )

  ctx.get = (name) => (name === 'llm' ? rollupReply([{ title: 'Dense', body }]) : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb-tok-l2', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )

  const rows = queryInjectionRows(store)
  assert.equal(rows.length, 1, 'the block was written')
  assert.ok(
    packetTokens(rows) <= SCENARIO_MAX_TOKENS,
    `the stored block renders within its ceiling (${packetTokens(rows)} <= ${SCENARIO_MAX_TOKENS})`,
  )
  registry.dispose()
  cleanup(root)
})

test('L3 write path: the portrait is bounded by rendered tokens, not characters', async () => {
  // The SECOND execution point, asserted separately on purpose: these are two
  // call sites of one rule, and ADR 0007's lesson 6 is that a paired fix which
  // ships half-applied degrades silently. Reverting `parsePersona` alone to
  // `.slice(0, PERSONA_TARGET_CHARS)` turns this red while the L2 test above
  // stays green — which is exactly the half-fix this guards against.
  const { root, registry, principal, ctx } = setup()
  await (async () => {})()
  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()
  global.tx(() => {
    global.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'preference', 'private', 'active', 'be terse', 'short answers', 'human', 0, 0)`,
      )
      .run(randomUUID())
  })

  const body = dense(PERSONA_TARGET_CHARS, 4)
  assert.equal(body.length, PERSONA_TARGET_CHARS, 'the fixture is exactly at the character target')
  assert.ok(
    estimateTokens(renderEntry({ id: '', kind: 'preference', title: PERSONA_TITLE, body }, false)) >
      PERSONA_MAX_TOKENS,
    'precondition: character-legal, token-illegal — the two rules disagree on this fixture',
  )

  await judgePersona(ctx, global, personaReply(body), 'pj-tok')
  const stored = global.db.prepare(`SELECT title, body FROM memories WHERE derived = 3`).all()
  assert.equal(stored.length, 1, 'a portrait was written')
  assert.ok(
    estimateTokens(renderEntry({ id: '', kind: 'preference', ...stored[0] }, false)) <=
      PERSONA_MAX_TOKENS,
    'the stored portrait renders within the cap injection will apply to it',
  )
  registry.dispose()
  cleanup(root)
})

test('the derived REGRESSION: a compliant dense portrait reaches the packet instead of vanishing', async () => {
  // Defect A itself, end to end, through the real writer and the real
  // injection path. Before this round: a portrait at exactly
  // PERSONA_TARGET_CHARS carrying 21 line breaks priced 172 against a cap of
  // 171, and `withinBudget` skipped it WHOLE — zero personal rows injected,
  // in every repository. The live portrait on this machine renders at 163,
  // i.e. production was running on 8 tokens of luck.
  //
  // The assertion is that the content ARRIVES, not that it is short: the
  // failure mode was silent absence, so absence is what must be caught.
  const { root, registry, principal, ctx, service } = setup()
  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()
  global.tx(() => {
    global.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'preference', 'private', 'active', 'be terse', 'short answers', 'human', 0, 0)`,
      )
      .run(randomUUID())
  })

  // 600 characters with 21 newlines: the exact shape measured at 172 tokens.
  const marker = 'PORTRAIT-MARKER'
  const body = marker + dense(PERSONA_TARGET_CHARS - marker.length, 27)
  assert.equal(body.length, PERSONA_TARGET_CHARS, 'exactly at the target the prompt asks for')
  assert.ok((body.match(/\n/g) ?? []).length >= 21, 'and carrying the density that broke it')
  assert.ok(
    estimateTokens(renderEntry({ id: '', kind: 'preference', title: PERSONA_TITLE, body }, false)) >
      PERSONA_MAX_TOKENS,
    'precondition: stored verbatim this portrait is unaffordable, which is why it used to vanish',
  )

  await judgePersona(ctx, global, personaReply(body), 'pj-regress')
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  assert.match(packet, /PORTRAIT-MARKER/, 'the portrait reaches the packet rather than being dropped')
  assert.ok(packet.includes(TRUNCATION_MARK), 'and arrives visibly cut rather than silently partial')
  registry.dispose()
  cleanup(root)
})

test('end to end: a dense rollup delivers ALL six blocks AND the portrait', async () => {
  // The capacity guard's arithmetic, executed rather than restated: the whole
  // point of solving 171 + 6 x 188 <= 1300 is that a full derived layer fits
  // at once. Every row here goes in through `runRebuildJob` — no hand-written
  // INSERT — because a test that fabricates derived rows validates the
  // fabricator's assumptions about the writer, not the writer (ADR 0009 §7).
  //
  // lineLen 6 is chosen to be far denser than `DERIVED_WORST_LINE_CHARS` (30)
  // prices: under the old character rule this is the case where the blocks
  // were dropped one by one (measured: 6/6 at 1 per 30, 5/6 at 1 per 10, 4/6
  // at 1 per 3). Reverting either write point turns this red.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)

  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()
  global.tx(() => {
    global.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'preference', 'private', 'active', 'be terse', 'short answers', 'human', 0, 0)`,
      )
      .run(randomUUID())
  })
  await judgePersona(ctx, global, personaReply(dense(PERSONA_TARGET_CHARS, 6)), 'pj-e2e')

  const blocks = Array.from({ length: ROLLUP_MAX_SCENARIOS }, (_, i) => ({
    title: `SCENARIO-${i} `.padEnd(ROLLUP_TITLE_TARGET_CHARS, 'x'),
    body: `SCEN${i}\n${dense(ROLLUP_TARGET_CHARS, 6)}`,
  }))
  ctx.get = (name) => (name === 'llm' ? rollupReply(blocks) : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb-e2e', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(
    queryInjectionRows(store).length,
    ROLLUP_MAX_SCENARIOS,
    'precondition: the writer stored a full derived layer',
  )

  // Every block AND the portrait survive the real budget, in one packet.
  const packet = buildContextProvider(ctx, service)({ agent: principal })
  for (let i = 0; i < ROLLUP_MAX_SCENARIOS; i++) {
    assert.match(packet, new RegExp(`SCENARIO-${i}`), `block ${i} reached the packet`)
  }
  assert.match(packet, /How to work with this user/, 'and so did the portrait')
  // Nothing was dropped — stated as a COUNT rather than a token total. The
  // budget the guard solves is spent per entry (`withinBudget` subtracts
  // `estimateTokens(renderEntry(hit))` one row at a time), so the guarantee is
  // "all seven rows are affordable", not "the concatenated packet re-measures
  // under 1299": re-estimating the joined string rounds once instead of seven
  // times and adds the newlines that join the bullets, which is a different
  // quantity that no code anywhere checks. Asserting that one would be
  // inventing a third ruler for a container that already has one.
  assert.equal(
    countEntries(packet),
    ROLLUP_MAX_SCENARIOS + 1,
    'all six blocks and the portrait were affordable at once — nothing was skipped',
  )
  registry.dispose()
  cleanup(root)
})

test('the token ceilings are SOLVED, not chosen: one more token overflows the packet', async () => {
  // The 1 token of slack in 171 + 6 x 188 = 1299 <= 1300 is deliberate, and
  // deliberate is only distinguishable from lucky if something breaks when it
  // is spent. Patching SCENARIO_MAX_TOKENS to 189 must fail AT LOAD.
  //
  // A guard nothing can trip is not a guard (the lesson `10b` in group.test
  // records): without this, the ceilings could drift upward and the capacity
  // inequality would be a comment rather than a check.
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const libDir = join(import.meta.dirname, '..', 'lib')
  const source = readFileSync(join(libDir, 'constants.js'), 'utf8')
  const patched = source.replace(
    /export const SCENARIO_MAX_TOKENS = [\d_]+;/,
    'export const SCENARIO_MAX_TOKENS = 189;',
  )
  assert.notEqual(patched, source, 'the probe must actually rewrite the ceiling')

  const probe = join(libDir, `constants.ceiling-probe.${randomUUID()}.js`)
  writeFileSync(probe, patched)
  try {
    await assert.rejects(import(`file://${probe}`), (error) => {
      assert.match(error.message, /derived layer cannot fit/, 'names the rule it broke')
      assert.match(error.message, /INJECT_BODY_BUDGET_TOKENS \(\d+\)/, 'reports the budget')
      return true
    })
  } finally {
    rmSync(probe, { force: true })
  }
})

test('the truncation mark does not name a container it is not confined to', async () => {
  // The mark used to read "…truncated to fit the recall budget", which was
  // true while recall was the only caller. The derived write path cuts against
  // the INJECTION budget and PERSISTS the result, so that wording became a
  // false sentence written into SQLite and shipped to the model on every turn.
  //
  // ## This is a BLACKLIST, and it is worth saying so
  //
  // The property one would want is "the mark names no container at all". That
  // is not machine-checkable: naming a container is a fact about English, and
  // any predicate for it is a word list wearing a property's clothes. This
  // assertion is therefore an enumeration of the container names REACHABLE
  // FROM THIS CODEBASE, not a proof of the general property.
  //
  // Its limit is known and measured: a wording that names a container using
  // vocabulary absent from the list — "…to fit the context packet budget" —
  // passes here (verified: 231/231 green with that wording). So this catches a
  // REGRESSION to a previously-shipped phrasing, and does not catch an
  // invented one. A reviewer changing this string still has to think; this
  // only stops the specific slide back to naming `recall` or `inject`.
  //
  // Kept as a blacklist rather than upgraded to an equality on today's exact
  // text: an equality would forbid ever rephrasing the mark, which is a real
  // cost, and it would still not express the property. Honest and narrow beats
  // a broad-sounding assertion that is narrow underneath.
  const { TRUNCATION_MARK: mark } = await import('../lib/recall/render.js')
  assert.notEqual(mark, '', 'an empty mark would make every assertion here vacuous')
  // Every container this mark can currently be produced under. `budget` alone
  // is deliberately NOT listed: the mark must be free to say it was cut to fit
  // *a* budget — what it must not do is say WHICH.
  for (const container of ['recall', 'inject', 'injection', 'packet', 'context', 'memory budget of']) {
    assert.doesNotMatch(
      mark,
      new RegExp(container, 'i'),
      `the mark (${JSON.stringify(mark)}) names "${container}". It is written into stored ` +
        'derived bodies by pipeline/rebuild.ts and into transient recall packets by ' +
        'tools.ts — naming either container makes it a false sentence in the other, and ' +
        'it is ONE constant precisely so there is no second one to keep in step',
    )
  }

  // And it really is the SAME constant on the write path, not a lookalike:
  // a stored derived body carries this exact string.
  const { root, registry, ctx } = setup()
  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()
  global.tx(() => {
    global.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'preference', 'private', 'active', 'be terse', 'short answers', 'human', 0, 0)`,
      )
      .run(randomUUID())
  })
  await judgePersona(ctx, global, personaReply('y'.repeat(4_000)), 'pj-mark')
  const stored = global.db.prepare(`SELECT body FROM memories WHERE derived = 3`).get()
  assert.ok(
    stored.body.endsWith(mark),
    'the stored portrait ends with the one shared mark, so the wording above is the wording persisted',
  )
  registry.dispose()
  cleanup(root)
})

test('a body too dense to cut is DROPPED, not stored as undefined', async () => {
  // `truncatedToBudget` returns `undefined` when even the bare mark overflows
  // the budget. At the shipped ceilings that is unreachable, so the branch is
  // proven at the unit — a row whose title alone exhausts the budget — and
  // then the write path is shown to refuse it rather than let `undefined`
  // reach SQLite (where `body` would become NULL and inject as an empty
  // bullet that still costs the packet a line).
  const { truncatedToBudget } = await import('../lib/recall/render.js')
  const unfittable = truncatedToBudget(
    { id: '', kind: 'fact', title: 'x'.repeat(400), body: 'anything at all' },
    4,
  )
  assert.equal(unfittable, undefined, 'precondition: the budget cannot hold even the mark')

  // And the shipped ceilings are on the other side of that line, which is what
  // makes the `continue` a safety net rather than the normal path.
  assert.ok(
    truncatedToBudget(
      { id: '', kind: 'fact', title: 'x'.repeat(ROLLUP_TITLE_TARGET_CHARS), body: 'x'.repeat(9_000) },
      SCENARIO_MAX_TOKENS,
    ) !== undefined,
    'a real oversized block is cut rather than dropped',
  )

  // The portrait path refuses rather than storing an empty body: there is no
  // sibling row to fall back on, so '' would blank the portrait everywhere.
  const { root, registry, ctx } = setup()
  const global = registry.get(GLOBAL_STORE_KEY) ?? registry.openGlobal()
  global.tx(() => {
    global.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, 'preference', 'private', 'active', 'be terse', 'short answers', 'human', 0, 0)`,
      )
      .run(randomUUID())
  })
  await assert.rejects(
    judgePersona(ctx, global, personaReply('   '), 'pj-empty'),
    /carries no body/,
    'an unusable portrait reaches the retry exit instead of being stored',
  )
  assert.equal(
    global.db.prepare(`SELECT count(*) c FROM memories WHERE derived = 3`).get().c,
    0,
    'and nothing was written',
  )
  registry.dispose()
  cleanup(root)
})

test('L3: the portrait reaches a brand-new repository, and a repo-less session', async () => {
  const { root, registry, principal, ctx, service } = setup()
  await service.propose(
    { title: 'be terse', body: 'short answers', kind: 'preference', scope: 'personal' },
    principal,
  )
  const global = registry.get(GLOBAL_STORE_KEY)
  await judgePersona(ctx, global, personaReply('Terse, direct, evidence-led.'), 'pj-new')

  // A repository this user has never opened before.
  clearRepoIdentityMemo()
  const fresh = makeRepo()
  const newcomer = fakeAgent({ id: 'newcomer', cwd: fresh })
  const freshCtx = fakeCtx({ agents: [newcomer] })
  const freshService = Object.setPrototypeOf(
    { ctx: freshCtx, stores: registry }, MemoryService.prototype,
  )
  const packet = buildContextProvider(freshCtx, freshService)({ agent: newcomer })
  assert.match(packet, /Terse, direct/, 'the portrait is there on the first turn')

  // And a session with no git work tree at all — that is what makes it personal.
  const stray = fakeAgent({ id: 'stray', cwd: tempRoot() })
  const strayCtx = fakeCtx({ agents: [stray] })
  const strayService = Object.setPrototypeOf(
    { ctx: strayCtx, stores: registry }, MemoryService.prototype,
  )
  assert.match(buildContextProvider(strayCtx, strayService)({ agent: stray }), /Terse, direct/)
  registry.dispose()
  cleanup(root)
})

test('L3: without an llm route nothing is queued and injection degrades to atoms', async () => {
  const { root, registry, principal, ctx, service } = setup()
  await service.propose(
    { title: 'answer in Chinese', body: 'the user prefers Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  const global = registry.get(GLOBAL_STORE_KEY)
  ctx.get = () => undefined // neither llm nor a default route
  assert.equal(enqueueRebuildIfOverflowing(ctx, global, Date.now()), false, 'nothing queued')
  assert.equal(global.db.prepare(`SELECT count(*) c FROM jobs`).get().c, 0)
  // The raw preferences still inject — degraded, not broken.
  assert.match(
    buildContextProvider(ctx, service)({ agent: principal }),
    /prefers Chinese/,
  )
  registry.dispose()
  cleanup(root)
})

test('a rebuild queued for a superseded revision is fenced without an LLM call', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  const stale = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: stale, provider: 'p', model: 'm' }, 0)

  // The snapshot moves before the job runs.
  await service.propose({ title: 'moved on', body: 'newer', kind: 'fact' }, principal)

  let called = false
  ctx.get = (name) => (name === 'llm' ? { stream: () => { called = true; throw new Error('must not call') } } : undefined)
  const built = await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: stale, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  assert.equal(built, false, 'fenced')
  assert.equal(called, false, 'no tokens burned on a stale snapshot')
  assert.equal(store.db.prepare(`SELECT state FROM jobs WHERE id = 'rb1'`).get().state, 'done')
  registry.dispose()
  cleanup(root)
})

test('a rollup bounds the prompt it builds from an unbounded overflow', async () => {
  // The live failure this closes: the derived layer is triggered BY an
  // overflow, so its input grew with the very condition that triggers it.
  // A store with 27 mostly-Chinese memories produced a 12574-character
  // prompt, which together with the reply it invites finished as
  // `max-tokens` — after the output cap had already been raised once.
  // Raising it again would work around the same cause twice; the input is
  // what was never bounded, unlike `extract`, which always had a cap.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  for (let i = 0; i < 40; i++) {
    await service.propose(
      { title: `记忆条目 ${i}`, body: '正文'.repeat(200), kind: 'fact' },
      principal,
    )
  }

  let sent = ''
  ctx.get = (name) =>
    name === 'llm'
      ? {
          stream: ({ messages }) => {
            sent = messages[0].content[0].text
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'text-delta', text: JSON.stringify({ scenarios: [{ title: '场景', body: '正文' }] }) }
                yield { type: 'finish', reason: { kind: 'stop' } }
              },
            }
          },
        }
      : undefined

  const revision = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb-cap', { expectedRevision: revision, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: revision, provider: 'p', model: 'm' }, new AbortController().signal,
  )

  const fed = JSON.parse(sent).memories
  assert.ok(fed.length > 0, 'a rollup of nothing is a failed rollup, not a smaller one')
  assert.ok(fed.length < 40, 'the prompt must not grow with the overflow')
  const chars = fed.reduce((n, m) => n + m.title.length + m.body.length, 0)
  assert.ok(
    chars <= ROLLUP_TRANSCRIPT_CHARS + 800,
    `prompt content ${chars} must stay near the ${ROLLUP_TRANSCRIPT_CHARS} budget`,
  )
  registry.dispose()
  cleanup(root)
})

test('forget refuses a generated summary and points at the real source', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('summary') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  const derived = store.db.prepare(`SELECT id FROM memories WHERE derived != 0`).get()
  await assert.rejects(service.forget(derived.id, principal), /generated summary/)
  registry.dispose()
  cleanup(root)
})

test('share refuses a generated summary BEFORE prompting a human', async () => {
  // The sibling execution point of the refusal above, and nothing was guarding
  // it: deleting `share`'s `derived !== LAYER.RAW` line left the suite fully
  // green. It was first registered as a todo on the argument that the blast
  // radius was small; measuring what actually happens overturned that, so it is
  // fixed here rather than filed.
  //
  // Without the guard, sharing a ROLLUP prompts a human for approval, marks the
  // row `team-shareable, human_confirmed = 1`, and reports `shared: true` —
  // while the projection writes ZERO rows, because it selects raw rows only. A
  // human is asked to approve publishing something, told it was published, and
  // nothing was. That is this round's own defect class: a true-sounding
  // statement the system does not honour.
  //
  // The strongest assertion is `asked.length === 0`. Checking only the error
  // would still pass in a world where the human is prompted first and refused
  // afterwards — and being asked to approve something unpublishable IS the
  // defect, by `share`'s own "Scan BEFORE asking" rule.
  const { root, registry, principal, ctx, service } = setup()
  const store = service.storeFor(principal, true)
  await overflow(service, principal)
  ctx.get = (name) => (name === 'llm' ? rollupReply('summary') : undefined)
  const rev = readRevision(store)
  enqueueJob(store, 'rebuild', 'rb1', { expectedRevision: rev, provider: 'p', model: 'm' }, 0)
  await runRebuildJob(
    ctx, store, claimNextJob(store, Date.now(), Date.now() + 60_000),
    { expectedRevision: rev, provider: 'p', model: 'm' }, new AbortController().signal,
  )
  const derived = store.db.prepare(`SELECT id FROM memories WHERE derived != 0`).get()
  assert.ok(derived, 'the rebuild must really have produced a derived row')

  const asked = []
  service.ctx = {
    ...ctx,
    get: (name) =>
      name === 'approval'
        ? { request: async (req) => (asked.push(req), 'allowed-once') }
        : ctx.get?.(name),
  }

  await assert.rejects(service.share(derived.id, principal), /is a generated summary/)
  assert.equal(
    asked.length,
    0,
    'a human must never be prompted to approve publishing a generated summary — the ' +
      'projection would write nothing and the "Shared." report would be false',
  )
  // And the row must not have been marked on the strength of an approval that
  // was never granted: a "prompt, mark, then fail" ordering would leave it
  // shareable forever.
  const after = store.db
    .prepare(`SELECT visibility, human_confirmed FROM memories WHERE id = ?`)
    .get(derived.id)
  assert.notEqual(after.visibility, 'team-shareable', 'the summary must not be marked shareable')
  assert.notEqual(after.human_confirmed, 1, 'and must not carry a human confirmation')
  registry.dispose()
  cleanup(root)
})

// ---------------------------------------------------- projection ---------

const approvalCtx = (base, outcome) => ({
  ...base,
  get: (name) => (name === 'approval' ? { request: async () => outcome } : base.get?.(name)),
})

test('secret scanner catches credential shapes and passes ordinary prose', () => {
  for (const bad of [
    'the token is ghp_abcdefghijklmnopqrstuvwxyz012345',
    'AWS key AKIAIOSFODNN7EXAMPLE is used',
    'password: hunter2000',
    '-----BEGIN RSA PRIVATE KEY-----',
    'api_key = 9f8e7d6c5b4a39281706',
  ]) {
    assert.equal(looksSecret(bad), true, `should flag: ${bad}`)
  }
  for (const ok of [
    'use pnpm instead of npm',
    'the deploy procedure is make deploy',
    'prefer Chinese replies with short paragraphs',
  ]) {
    assert.equal(looksSecret(ok), false, `should pass: ${ok}`)
  }
})

test('share requires approval; a rejection changes nothing', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose({ title: 'team fact', body: 'shared knowledge', kind: 'fact' }, principal)

  // No approval service at all ⇒ fail closed.
  await assert.rejects(service.share(id, principal), /requires the approval service/)

  // Explicit rejection ⇒ nothing is promoted or written.
  service.ctx = approvalCtx(ctx, 'rejected')
  const denied = await service.share(id, principal)
  assert.equal(denied.shared, false)
  const store = service.storeFor(principal, false)
  assert.equal(
    store.db.prepare(`SELECT visibility, human_confirmed FROM memories WHERE id = ?`).get(id).visibility,
    'repo-local',
    'still private to this machine',
  )
  registry.dispose()
  cleanup(root)
})

test('an approved share promotes, projects the file, and revoking removes it', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose(
    { title: 'deploy procedure', body: 'run make deploy from the repo root', kind: 'procedure' },
    principal,
  )
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const shared = await service.share(id, principal)
  assert.equal(shared.shared, true)

  const file = join(repo, PROJECTION_DIR, PROJECTION_FILE)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /deploy procedure/)
  assert.match(text, /make deploy/)
  assert.match(text, /never read back/, 'the file states it is not an input')

  await service.forget(id, principal)
  // This assertion used to be preceded by the test CALLING `projectStore`
  // itself, under the comment "Forgetting the shared memory rewrites the
  // projection away". That comment described what the TEST did, not what the
  // product did: `service.forget` never refreshed the projection, and the two
  // manual lines were the only thing making the file disappear. Removing them
  // on HEAD turned this test red (247/1) — the measurement that found the D5
  // projection-face gap. Kept here, mistake and all, because a test that
  // performs the behaviour it claims to observe is indistinguishable from a
  // passing one until someone deletes the setup.
  assert.equal(existsSync(file), false, 'no stale shared file survives')
  registry.dispose()
  cleanup(root)
})

test('forget closes the projection face D5 names, by refreshing it — not by deleting the file', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const alpha = await service.propose(
    { title: 'alpha rotation', body: 'rotate the alpha staging cluster weekly', kind: 'procedure' },
    principal,
  )
  const beta = await service.propose(
    { title: 'beta rotation', body: 'the beta cluster is rotated by hand', kind: 'procedure' },
    principal,
  )
  // B15: the count in the note is a STATEMENT TO THE USER about how many
  // memories now sit in the shared file, so it has to come from the projection
  // rather than from the fact that one share just happened. Two shares in a
  // row make a hardcoded `1` observable — with a single share, "wrote one row"
  // and "always says one" are indistinguishable.
  assert.match((await service.share(alpha.id, principal)).note, /^Shared\. 1 memory/)
  assert.match((await service.share(beta.id, principal)).note, /^Shared\. 2 memor/)

  const file = join(repo, PROJECTION_DIR, PROJECTION_FILE)
  assert.match(readFileSync(file, 'utf8'), /alpha staging cluster/)

  // ONLY the product call. Nothing in this test touches `projectStore`.
  await service.forget(alpha.id, principal)

  const text = readFileSync(file, 'utf8')
  assert.equal(/alpha staging cluster/.test(text), false, 'the forgotten bytes are gone from disk')
  assert.match(text, /rotated by hand/, 'a refresh, not a deletion: beta is still published')

  // A rolled-back forget must leave the file untouched. The filesystem is not
  // in the transaction, so this only holds while the refresh runs strictly
  // AFTER `commitL1Mutation` — move it before and a refusal would still have
  // rewritten a checked-in file.
  await assert.rejects(service.forget(alpha.id, principal), /already forgotten/)
  assert.equal(readFileSync(file, 'utf8'), text, 'a refused forget writes nothing to disk')
  registry.dispose()
  cleanup(root)
})

test('forget refreshes only THIS checkout: one store maps to N checkouts', async () => {
  clearRepoIdentityMemo()
  const base = tempRoot()
  // Two clones of the same origin. `deriveRepoIdentity` hashes the REMOTE URL,
  // so they are one store — the fact that makes "which checkout holds the
  // projection?" unanswerable from a store.
  const checkouts = ['A', 'B'].map((name) => {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/t/shared.git'], {
      cwd: dir,
    })
    return dir
  })
  const { root, registry } = openRegistry()
  const inA = fakeAgent({ id: 'pa', cwd: checkouts[0] })
  const inB = fakeAgent({ id: 'pb', cwd: checkouts[1] })
  const service = Reflect.construct(function () {}, [])
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = approvalCtx(fakeCtx({ agents: [inA, inB] }), 'allowed-once')
  service.stores = registry

  assert.equal(
    service.storeFor(inA, true),
    service.storeFor(inB, true),
    'same origin ⇒ same store: a store cannot name the checkout that holds its projection',
  )

  // TWO shared memories, and only one is forgotten. That detail is the whole
  // fixture: with a single share, forgetting it leaves zero projectable rows,
  // and the zero-row branch writes nothing ANYWAY — so a build with no
  // `existsSync` guard at all would still leave B clean and the test would
  // pass while measuring nothing. A surviving second row is what makes a
  // missing guard observable: without it the refresh CREATES B's projection.
  const { id } = await service.propose(
    { title: 'release ritual', body: 'tag from main only', kind: 'procedure' },
    inA,
  )
  const survivor = await service.propose(
    { title: 'review ritual', body: 'two approvals before merge', kind: 'procedure' },
    inA,
  )
  await service.share(id, inA)
  await service.share(survivor.id, inA)
  assert.equal(existsSync(join(checkouts[0], PROJECTION_DIR, PROJECTION_FILE)), true)
  assert.equal(existsSync(join(checkouts[1], PROJECTION_DIR)), false, 'share never reached B')

  // B2: B now gets a checked-in `.repo_memory/` holding the team's OWN files
  // and no generated projection — the realistic state of a fresh clone, since
  // `.repo_memory/` is committed. It is also what separates guard 3's two
  // plausible spellings: testing for the DIRECTORY here would report "a
  // projection lives here" and publish approved memories into a checkout
  // nobody published into, so the guard must test for the FILE.
  const dirB = join(checkouts[1], PROJECTION_DIR)
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'NOTES.md'), '# team notes, checked in, not ours\n', 'utf8')

  // Forgetting from B must not fabricate a projection in B. B never had one;
  // creating one there would publish approved memories into a checkout nobody
  // asked to publish into — a new leak invented by a deletion.
  await service.forget(id, inB)
  assert.equal(
    existsSync(join(dirB, PROJECTION_FILE)),
    false,
    'forget refreshes an existing projection; it never creates one',
  )
  assert.equal(existsSync(join(dirB, 'NOTES.md')), true, "B's own files are untouched")
  registry.dispose()
  cleanup(root)
  cleanup(base)
})

test('forgetting a personal memory never touches the repo projection (ADR 0001)', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const shared = await service.propose(
    { title: 'build command', body: 'run npm run build before testing', kind: 'procedure' },
    principal,
  )
  assert.equal((await service.share(shared.id, principal)).shared, true)
  const file = join(repo, PROJECTION_DIR, PROJECTION_FILE)
  const before = readFileSync(file, 'utf8')

  // Lives in the global store, which is not this session's repo store.
  const personal = await service.propose(
    { title: 'be terse', body: 'short answers, no preamble', kind: 'preference', scope: 'personal' },
    principal,
  )
  await service.forget(personal.id, principal)

  assert.equal(readFileSync(file, 'utf8'), before, 'a global-store forget writes no repo file')
  registry.dispose()
  cleanup(root)
})

test('forget removes the generated file only, leaving hand-written neighbours alone', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const { id } = await service.propose(
    { title: 'oncall handoff', body: 'hand over at 09:00 local time', kind: 'procedure' },
    principal,
  )
  assert.equal((await service.share(id, principal)).shared, true)

  // `.repo_memory/` is checked in: teams keep their own files beside ours.
  const dir = join(repo, PROJECTION_DIR)
  const notes = join(dir, 'NOTES.md')
  writeFileSync(notes, '# hand-written, version-controlled, not ours\n', 'utf8')

  await service.forget(id, principal)

  assert.equal(existsSync(join(dir, PROJECTION_FILE)), false, 'the generated file is gone')
  assert.equal(existsSync(notes), true, 'the hand-written neighbour survives')
  registry.dispose()
  cleanup(root)
})

/**
 * T5/T6 pin the rule "a projection write that fails must not fail a forget".
 * The tombstone commits BEFORE the refresh, so by the time the file is touched
 * the deletion is permanently done: throwing would report failure for finished
 * work and send the model into a retry that `already forgotten` refuses —
 * a split brain whose only escape hatch, a later refresh, no longer exists.
 *
 * Two obstructions, because they enter `projectStore` through different calls:
 * a read-only FILE stops `writeFileSync` with EACCES on the rewrite path,
 * while a `memories.md` that is a DIRECTORY stops `rmSync` on the zero-row
 * path with EISDIR — which `force: true` does NOT suppress, it suppresses
 * ENOENT only. An earlier revision guarded only the `readdirSync`/`rmdirSync`
 * cleanup and left `rmSync`, `mkdirSync` and `writeFileSync` bare, so both of
 * these threw.
 *
 * T5 obstructs the FILE, not the directory, and that was a measured
 * correction rather than a preference: the first version chmod'ed the
 * DIRECTORY to 0o500 and survived every mutant, because POSIX write
 * permission on a directory governs creating and unlinking entries, not
 * rewriting an existing file through an already-resolvable path (measured:
 * `writeFileSync` into a 0o500 directory succeeds when the file exists).
 * The test was green for the same reason a build with no error handling at
 * all was green — nothing ever threw. Same family as the T2 fixture
 * degeneracy: an obstruction that does not obstruct pins nothing.
 */
test('forget survives a projection write it cannot perform (read-only file)', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const alpha = await service.propose(
    { title: 'alpha rotation', body: 'rotate the alpha staging cluster weekly', kind: 'procedure' },
    principal,
  )
  const beta = await service.propose(
    { title: 'beta rotation', body: 'the beta cluster is rotated by hand', kind: 'procedure' },
    principal,
  )
  await service.share(alpha.id, principal)
  await service.share(beta.id, principal)

  // A survivor keeps this on the REWRITE path: with beta still projectable the
  // refresh must call `writeFileSync`, which a read-only FILE refuses with
  // EACCES. Forgetting the last row instead would take the zero-row path and
  // measure something else — that one is T6's job.
  const dir = join(repo, PROJECTION_DIR)
  const file = join(dir, PROJECTION_FILE)
  chmodSync(file, 0o400)
  try {
    await service.forget(alpha.id, principal)
  } finally {
    chmodSync(file, 0o600)
  }

  // The deletion is real and complete in the store, which is what makes
  // swallowing the write failure honest rather than a cover-up.
  const row = service
    .storeFor(principal, false)
    .db.prepare(`SELECT status, title, body FROM memories WHERE id = ?`)
    .get(alpha.id)
  assert.deepEqual(
    { status: row.status, title: row.title, body: row.body },
    { status: 'tombstone', title: '', body: '' },
    'the forget itself happened',
  )

  // And the store is still the truth: once the obstruction is gone, the next
  // forget re-projects and the stale bytes leave disk. The swallow costs a
  // delay, not the guarantee.
  await service.forget(beta.id, principal)
  assert.equal(
    existsSync(join(dir, PROJECTION_FILE)),
    false,
    'a later refresh heals the file the failed one could not write',
  )
  registry.dispose()
  cleanup(root)
})

test('forget survives a projection path that cannot be removed (memories.md is a directory)', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const { id } = await service.propose(
    { title: 'oncall handoff', body: 'hand over at 09:00 local time', kind: 'procedure' },
    principal,
  )
  assert.equal((await service.share(id, principal)).shared, true)

  // Needs no special permissions: EISDIR is reachable by any user.
  const file = join(repo, PROJECTION_DIR, PROJECTION_FILE)
  rmSync(file)
  mkdirSync(file)

  // The single shared row: forgetting it leaves zero projectable rows, so the
  // refresh takes the `rmSync` path and hits EISDIR.
  await service.forget(id, principal)

  const row = service
    .storeFor(principal, false)
    .db.prepare(`SELECT status, title, body FROM memories WHERE id = ?`)
    .get(id)
  assert.deepEqual(
    { status: row.status, title: row.title, body: row.body },
    { status: 'tombstone', title: '', body: '' },
    'the forget itself happened',
  )
  registry.dispose()
  cleanup(root)
})

/**
 * `share` takes the OPPOSITE branch of the same rule, and that asymmetry is
 * the whole reason `refreshProjection` returns `ok` instead of just a count.
 * `share` is a publish: a human was asked "commit this so your team sees it"
 * and said yes, so reporting "Shared." over a file that was never written is
 * its own dishonesty. It is also recoverable in a way `forget` is not — the
 * row stays `team-shareable, human_confirmed = 1`, so sharing again
 * re-projects the whole table — which makes an error something the caller can
 * act on rather than the dead end swallowing would create.
 */
test('share REPORTS a projection write it cannot perform, and stays retryable', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  service.ctx = approvalCtx(ctx, 'allowed-once')
  const { id } = await service.propose(
    { title: 'deploy ritual', body: 'deploy from main after the smoke suite', kind: 'procedure' },
    principal,
  )

  const dir = join(repo, PROJECTION_DIR)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o500)
  try {
    await assert.rejects(
      service.share(id, principal),
      /could not be written/,
      'a publish that published nothing must not answer "Shared."',
    )
  } finally {
    chmodSync(dir, 0o700)
  }

  // Retryable, and the retry actually publishes: the approval is not consumed
  // by the failure, so the human is not asked to bless the same memory twice.
  const retry = await service.share(id, principal)
  assert.equal(retry.shared, true)
  assert.match(readFileSync(join(dir, PROJECTION_FILE), 'utf8'), /smoke suite/)
  registry.dispose()
  cleanup(root)
})

/**
 * B5: "`refreshProjection` is the only writer of the projection" is the
 * invariant the whole design rests on, and it was the one thing no test could
 * see — inlining `projectStore` back into `share` left all 252 green, because
 * the inlined call produces byte-identical output on the happy path. The
 * difference only surfaces in the guards and the failure handling, which is
 * exactly what a future "this indirection is pointless" tidy-up would delete.
 *
 * So this asserts over the SOURCE, the way the guidance-budget guard already
 * does in this package. That is deliberately structural, and justified here
 * because the property IS structural: a behavioural test cannot distinguish
 * "one writer" from "two writers that happen to agree today".
 */
test('B5: projectStore has exactly one call site, and it is inside refreshProjection', () => {
  const src = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src')
  const callSites = []
  for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts') || file.endsWith('projection.ts')) continue
    const text = readFileSync(join(src, file), 'utf8')
    // Call sites only: `projectStore(` with an argument list. The import in
    // service.ts reads `projectStore,` and does not match.
    for (const [index, line] of text.split('\n').entries()) {
      if (/\bprojectStore\s*\(/.test(line)) callSites.push({ file, index })
    }
  }
  assert.equal(
    callSites.length,
    1,
    'projectStore must be called from exactly one place. A second call site bypasses the ' +
      'three guards AND the single failure handler, and no behavioural test can catch that ' +
      'because the happy path is byte-identical.',
  )
  // Deliberately NOT asserting the call line verbatim: that would pin the
  // expression's spelling rather than the invariant, and break on any harmless
  // refactor. What matters is that the one call sits inside `refreshProjection`
  // — so locate the enclosing method by the nearest preceding declaration.
  assert.equal(callSites[0].file, 'service.ts')
  const before = readFileSync(join(src, 'service.ts'), 'utf8')
    .split('\n')
    .slice(0, callSites[0].index)
  const enclosing = before.findLast((line) => /^ {2}(private |async |)[a-zA-Z]\w*\(/.test(line))
  assert.match(
    enclosing ?? '',
    /refreshProjection/,
    'the single projectStore call must live in refreshProjection, not in a caller',
  )
})

test('a credential-shaped memory is refused BEFORE anyone is asked to approve it', async () => {
  const { repo, root, registry, principal, ctx, service } = setup()
  const { id } = await service.propose(
    { title: 'ci token', body: 'the CI token is ghp_abcdefghijklmnopqrstuvwxyz012345', kind: 'fact' },
    principal,
  )
  let asked = false
  service.ctx = {
    ...ctx,
    get: (name) =>
      name === 'approval'
        ? { request: async () => { asked = true; return 'allowed-once' } }
        : undefined,
  }
  const result = await service.share(id, principal)
  assert.equal(result.shared, false)
  assert.match(result.note, /credential/)
  assert.equal(asked, false, 'never prompt a human for something we would refuse anyway')

  // The row was NOT promoted, so nothing can leak later.
  const store = service.storeFor(principal, false)
  assert.equal(
    store.db.prepare(`SELECT visibility FROM memories WHERE id = ?`).get(id).visibility,
    'repo-local',
  )
  assert.equal(existsSync(join(repo, PROJECTION_DIR, PROJECTION_FILE)), false)
  registry.dispose()
  cleanup(root)
})

test('the projection re-scans as a backstop, even for an already-promoted row', () => {
  const { repo, root, registry } = openRegistry()
  const store = registry.open('k1')
  // A row promoted by some earlier path (or an older build) that carries a secret.
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance,
           created_at, updated_at, human_confirmed)
         VALUES ('leak','fact','team-shareable','active','deploy key',
                 'AKIAIOSFODNN7EXAMPLE is the key','human',0,0,1)`,
      )
      .run()
  })
  const dir = tempRoot()
  const report = projectStore(store, dir)
  assert.equal(report.written, 0)
  assert.equal(report.skippedSecrets, 1, 'the write path refuses it independently')
  registry.dispose()
  cleanup(root)
  cleanup(dir)
})

test('personal and derived memories are never shareable', async () => {
  const { root, registry, principal, ctx, service } = setup()
  const personal = await service.propose(
    { title: 'be terse', body: 'short answers', kind: 'preference', scope: 'personal' },
    principal,
  )
  service.ctx = approvalCtx(ctx, 'allowed-once')
  // The personal memory lives in the global store, so the repo-scoped share
  // cannot find it at all.
  await assert.rejects(service.share(personal.id, principal), /no memory with id/)
  registry.dispose()
  cleanup(root)
})
