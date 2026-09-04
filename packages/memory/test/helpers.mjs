/**
 * Test helpers: temp store roots, fake agents shaped like the platform's
 * duck-typed surface, a minimal ctx stub for units that only need
 * agents.get / logger / ctx.get, and the SHARED honesty guards every
 * model-facing string in this plugin must pass.
 */
import assert from 'node:assert/strict'
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

/**
 * A `tool/call` event. `args` is the RAW argument string the platform records
 * — the model's unparsed output — so tests can hand it anything a model could
 * produce, including strings that are not JSON at all.
 */
export const toolCallEvent = (turn, callId, name, args = '{}') => ({
  type: 'tool/call',
  data: { turn, step: 0, callId, name, arguments: args },
})

// ------------------------------------------------ shared honesty guards ----

/**
 * The FALSE-ADVICE SET: every actionable payload this plugin has shipped and
 * then had to delete, plus the shapes they generalise to.
 *
 * ⛔ WHY THIS LIVES IN `helpers.mjs` AND NOT IN A TEST FILE (rework, step 3c).
 * The previous round factored these guards into `assertHonestRefusal` inside
 * `layers.test.mjs` and applied them to the two `service.ts` sentences — and
 * to NOTHING ELSE. The three MODEL-FACING DESCRIPTION STRINGS the same round
 * edited (`tools.ts`'s tool description, its `sourceOf` parameter description,
 * and `GUIDANCE_SECTION.text`) carried no guard at all, and three mutations
 * proven landed in `lib/` ALL SURVIVED at 298/298/0:
 *
 * ```
 * MK  sourceOf param: `The memory is unaffected either way.`
 *                  -> `Forget it and recall it again to fix this.`   298/298/0
 * MM  tool description + the literal v0.4.16 payload
 *     `Start a session inside that checkout and retry.`              298/298/0
 * MN  GUIDANCE_SECTION + `If none, forget it.` (157 <= 160 tokens,
 *     so the load-time budget assertion does not catch it)           298/298/0
 * ```
 *
 * That is the SIXTH occurrence of "one rule, N execution points, only some
 * guarded"; the slice this time was *service sentences vs. tool-description
 * sentences*. A helper that lives in the file holding one slice's tests is a
 * helper the other slice will not import. It lives here, beside `fakeAgent`,
 * because `layers.test.mjs` and `group.test.mjs` both already import from
 * here, and so will whatever file states the next model-facing string.
 *
 * EACH ENTRY IS A REAL DELETED PAYLOAD OR ITS GENERALISATION, not a guessed
 * bad word:
 *   - `start a session inside` / `cannot be removed until a checkout` —
 *     v0.4.16's two falsified halves.
 *   - `forget the underlying` / `recall it to get its id` — the home sentence
 *     v0.4.16 proved false across the group boundary.
 *   - `rebuil|regenerat` — no rebuild produces a source passage; `rebuild.ts`
 *     writes derived rows with zero evidence rows.
 *   - `try again|retry` — MK's shape: advice to re-run something whose outcome
 *     cannot change.
 *   - DESTRUCTIVE IMPERATIVE — see below; this one is a PROPERTY, not a
 *     spelling, and it is the entry that had to be rewritten.
 *
 * ⛔ THE DESTRUCTIVE-IMPERATIVE ENTRY IS A PROPERTY BECAUSE A SPELLING WAS NOT
 * ENOUGH, and that was measured DURING this rework rather than assumed. The
 * first draft of this list pinned MK's exact words (`forget it and recall it
 * again`). Re-running the matrix showed MN's payload — `If none, forget it.` —
 * matched NOTHING here: MN turned red only INCIDENTALLY, killed by
 * `guidance.test.mjs`'s unrelated anchor-uniqueness assertion, which would
 * have gone on "guarding" this string right up until someone changed the
 * anchor. A guard that catches a payload by accident is not a guard, and
 * pinning rejected byte strings instead of the property is the exact criticism
 * (S1) this round already accepted once for `GUIDANCE_SECTION`. So the entry
 * states the property: THESE SURFACES DESCRIBE A READ, AND A READ SURFACE MAY
 * NOT INSTRUCT THE MODEL TO DESTROY A MEMORY.
 *
 * The pattern matches an imperative `forget` with an OBJECT (`forget it`,
 * `forget them`, `forget the entry`) and deliberately does NOT match the tool
 * NAME `memory_forget`, which every one of these strings legitimately
 * mentions — verified against all three live strings, which pass.
 */
export const FALSE_ADVICE_PATTERNS = [
  [/start a session inside/i, 'v0.4.16 deleted this: the destination cannot satisfy the request'],
  [/cannot be removed until a checkout/i, 'v0.4.16 deleted this: no checkout ever helps'],
  [/forget the underlying/i, 'true at home, false across the group boundary'],
  [/recall it to get its id/i, 'there is no derived->source mapping to recall'],
  [/rebuil|regenerat/i, 'no rebuild produces a source passage'],
  [
    /(?<!memory_)\bforget\s+(it|them|this|that|these|those|the\b)/i,
    'a READ surface told the model to destroy the memory it could not fully answer about ' +
      '(MK, MN); naming the `memory_forget` tool is fine, commanding a deletion is not',
  ],
  [/\b(try again|retry)\b/i, 'advice to repeat an operation whose outcome cannot change'],
]

/**
 * The CONTRADICTION SET: a READ path may never claim it changed or destroyed
 * anything. `ML` inverted a refusal's tail to "The memory has been deleted as
 * a result." and shipped fully green before these guards were shared.
 */
export const DESTRUCTION_CLAIM =
  /delet|removed|erased|discarded|no longer (exists|available)|has been (changed|modified)/i

/**
 * Assert one MODEL-FACING STRING carries no false advice and no destruction
 * claim. This is the half of `assertHonestRefusal` that is true of EVERY
 * string this plugin shows a model — a refusal sentence, a tool description, a
 * parameter description, the per-request guidance section — as opposed to the
 * half that is specific to a refusal (naming the id, saying the memory
 * survived, matching an exact expected sentence).
 *
 * Splitting it out this way is what lets the description tests and the
 * sentence tests share ONE definition instead of drifting: a new payload added
 * here is instantly enforced on all six surfaces, which is exactly what did
 * not happen when the guards lived next to one of them.
 */
export const assertNoFalseAdvice = (text, label) => {
  assert.ok(typeof text === 'string' && text.length > 0, `${label} must be a non-empty string`)
  for (const [pattern, why] of FALSE_ADVICE_PATTERNS) {
    assert.doesNotMatch(text, pattern, `${label} carries unfollowable advice — ${why}`)
  }
  assert.doesNotMatch(
    text,
    DESTRUCTION_CLAIM,
    `${label} claims something was deleted, removed or altered; these surfaces only READ`,
  )
}

/**
 * The guards EVERY honest refusal sentence must pass — ONE definition, called
 * from the derived cases, the raw case, the non-session-evidence cases, and
 * `group.test.mjs`'s member-domain cases alike.
 *
 * ⛔ WHY THIS EXISTS (rework, step 3b) and WHY IT MOVED HERE (step 3c). The
 * first version guarded the DERIVED sentence in five places and the RAW
 * sentence in none: review replaced the RAW sentence's tail with the literal
 * v0.4.16 false-advice payload and the suite stayed 291/291/0; replacing it
 * with `The memory has been deleted as a result.` ALSO stayed green — a READ
 * path claiming it deleted the user's memory, fully green. Step 3b routed both
 * sentences through one function. Step 3c found that function living inside
 * `layers.test.mjs`, where `group.test.mjs`'s 6h cases could not reach it and
 * had re-implemented NINE of its assertions inline — the precise drift a
 * shared helper exists to prevent — and the three tool-description strings had
 * no guard at all.
 *
 * The fix is not "copy the assertions": copies drift, and the next string
 * added starts unguarded again. Every refusal sentence runs this function, and
 * every model-facing description runs `assertNoFalseAdvice`, which this
 * function calls — so the two sets cannot diverge.
 *
 * `expected` is the WHOLE sentence, compared byte-for-byte with the id
 * substituted out. Full equality is what actually kills an appended lie: a
 * message satisfying every positive assertion AND carrying unfollowable advice
 * differs from `expected`, so it cannot pass. The named negatives are kept ON
 * TOP of it deliberately — they cost nothing and they make a failure say WHICH
 * property broke instead of dumping two long strings.
 */
export const assertHonestRefusal = (message, id, expected) => {
  // 1. NOT a denial of existence. This is the defect itself, and it is
  //    asserted NEGATIVELY because a positive-only assertion passes on a
  //    message that says the right thing AND the wrong thing (NEG1-NEG4).
  assert.doesNotMatch(
    message,
    /no memory with id/,
    'a row that is present and active must never be told it does not exist',
  )
  assert.doesNotMatch(message, /was forgotten/, 'nor that it was forgotten — it was not')
  // 2. It names the id, so the caller can match the answer to the line
  //    `recall` gave them. Read from the fixture, never hardcoded.
  assert.match(message, new RegExp(id))
  // 3. No unfollowable advice, and no claim that a read destroyed anything —
  //    the SAME set the tool descriptions are held to.
  assertNoFalseAdvice(message, `the refusal for ${id}`)
  // 4. It says the memory survived. The positive clause is asserted here and
  //    its contradiction in `assertNoFalseAdvice`: it is the whole clause that
  //    got inverted to "The memory has been deleted as a result." and shipped
  //    green.
  assert.match(message, /memory itself is unaffected/i, 'the read path damaged nothing, and says so')
  // 5. And the whole sentence, byte for byte. The id is substituted out
  //    because it is the caller's own input; everything else is the promise.
  assert.equal(
    message.split(id).join('<ID>'),
    expected.split(id).join('<ID>'),
    'the exact sentence is the promise — an extra clause appended to a message that satisfies ' +
      'every assertion above is precisely what survived review',
  )
}

/**
 * The two honest sentences `service.source` throws, as the caller receives
 * them. Exported so `layers.test.mjs` and `group.test.mjs` assert the SAME
 * bytes — 6h previously hardcoded its own copy of the derived sentence, which
 * is how a wording rework can leave one file green and the other stale.
 */
export const DERIVED_SENTENCE = (id) =>
  `${id} is a generated summary, not a memory recorded from a conversation, so there is no ` +
  'source conversation of its own to show. The memory itself is unaffected.'
export const RAW_SENTENCE = (id) =>
  `${id} is a stored memory, but no source conversation was recorded for it, so ` +
  'there is nothing to show. The memory itself is unaffected.'
