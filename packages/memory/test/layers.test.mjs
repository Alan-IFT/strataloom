/**
 * The L0 conversation substrate and Personal Memory (cross-repo scope).
 * These are the two capabilities added after the P0/P1 core: the durable
 * record of what was said, and memories that follow the user across repos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService } from '../lib/service.js'
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
  EXTRACT_EVENT_EXCERPT_CHARS,
  INJECT_BODY_BUDGET_TOKENS,
  INJECT_TOP_N,
  L0_RETENTION_MS,
  RECALL_PACKET_BUDGET_TOKENS,
  ROLLUP_MAX_SCENARIOS,
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
import { RECALL_NO_MATCH, SOURCE_NOT_SHOWN, registerTools } from '../lib/tools.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import {
  enqueueRebuildIfOverflowing,
  packetOverflows,
  readRevision,
  runRebuildJob,
} from '../lib/pipeline/rebuild.js'
import { estimateTokens } from '../lib/constants.js'
import { looksSecret, projectStore, PROJECTION_DIR, PROJECTION_FILE } from '../lib/projection.js'
import { enqueueJob, claimNextJob, commitClaimedJob } from '../lib/pipeline/jobs.js'
import { queryInjectableSet, queryInjectionRows } from '../lib/store/fts.js'
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

test('a derived rollup can never go dormant (both writers now exist)', () => {
  const { root, registry } = openRegistry()
  const store = registry.open('k1')
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
         VALUES ('roll','fact','repo-local','active','rollup','body','derived',0,0,1)`,
      )
      .run()
  })
  assert.throws(
    () => store.db.prepare(`UPDATE memories SET status = 'dormant' WHERE id = 'roll'`).run(),
    /cannot go dormant/,
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
  assert.ok(estimateTokens(packet) <= 1400, 'and it fits the budget')
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
  assert.ok(estimateTokens(packet) <= 1400)

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

  // Forgetting the shared memory rewrites the projection away.
  await service.forget(id, principal)
  const store = service.storeFor(principal, false)
  const report = projectStore(store, repo)
  assert.equal(report.written, 0)
  assert.equal(existsSync(file), false, 'no stale shared file survives')
  registry.dispose()
  cleanup(root)
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
