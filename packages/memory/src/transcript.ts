/**
 * Turn transcript classification (spec §2.4): map each session event to its
 * CATEGORY-derived provenance. This is the injection safety boundary — the
 * model never assigns provenance, so this mapping must be total and must
 * fail closed (anything unmapped is `tool-output`, the lowest trust).
 *
 * It lives here rather than inside the extract job because BOTH the L0
 * capture at the turn boundary and the extract job classify the same events;
 * one classification, one place to audit.
 * @module @strataloom/dsh-memory/transcript
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Provenance } from './types.ts'
import { PROVENANCE_PRIORITY } from './types.ts'
import { EXTRACT_EVENT_EXCERPT_CHARS, TOOL_CALL_VALUE_CHARS } from './constants.ts'

/** One classified, content-bearing transcript event. */
export interface TranscriptEvent {
  readonly seq: number
  readonly label: string
  readonly text: string
  readonly provenance: Provenance
}

/**
 * Tool names whose results carry a child agent's own words.
 *
 * Only true in FOREGROUND delegation (`backgroundMode: one-shot`, or an
 * explicit `run_in_background: false`): there the tool resolves to
 * `{ kind: 'foreground', output }` and renders the child's output blocks
 * verbatim, so the tool result IS the subagent speaking. Under the
 * continuable background mode the same tool renders only a receipt
 * (`started subagent <id>`), which this set then over-trusts by one step —
 * accepted, because the receipt is runtime-authored boilerplate carrying no
 * child text, while dropping the set would silently demote every foreground
 * child's answer to `tool-output`.
 */
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'subagent_fork'])

/**
 * Message-source kinds that mean "another agent addressed this session".
 *
 * The truth source for identity is `kind`, never `form`. `form` is a
 * presentation shape — `relay`, `notice`, `snapshot` — that unrelated
 * producers reuse, so testing it both admits strangers (any plugin may emit
 * `relay`) and misses the real thing (a settlement notice is `notice`).
 * `kind` is the only field the platform guarantees to name the producer.
 *
 * Both kinds are `subagent`, not `human`, and are deliberately kept apart
 * upstream: `subagent-report` is content the child chose to send, while
 * `subagent-settled` is the runtime's account of how the child ended. They
 * share a trust level because neither is the principal human speaking.
 */
const SUBAGENT_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'subagent-report',
  'subagent-settled',
])

/** How much of a sender's session id identifies it in a label. */
const SENDER_ID_PREFIX = 8

/**
 * Characters a tool name may keep in a label, and how much of it survives.
 *
 * Wider than the sender charset because tool names legitimately carry `.` and
 * `:` (namespaced and MCP-style names), and narrower than "anything" because
 * the name is attacker-reachable: a tool whose name carries a newline would
 * otherwise write into the label. The length cap exists for the same reason
 * as the sender's — a label is an identifier, and an identifier that can be
 * arbitrarily long is a channel.
 */
const TOOL_NAME_CHARS = /[^A-Za-z0-9_.:-]/g
const TOOL_NAME_MAX = 64

/** Characters a sender's session id may keep in a label. */
const SENDER_ID_CHARS = /[^A-Za-z0-9_-]/g

/**
 * The two label families a tool event can land in, kept DELIBERATELY apart.
 *
 * A request and its result are different facts, and `metrics.ts` plus
 * `scripts/inspect.mjs` already read the result family as a population:
 * `WHERE label = 'tool:memory_recall' AND text LIKE 'No stored memories
 * matched.%'` is the recall miss rate, i.e. the number that gates the
 * retrieval-fusion decision (ADR 0005). Recording a call under the same label
 * would double `recallCalls` while leaving `recallMisses` untouched, halving a
 * rate nobody would notice had moved — the metric would keep returning a
 * number, and the number would be wrong.
 *
 * A separate PREFIX rather than a separate column: every consumer matches the
 * label by exact equality (five call sites across `metrics.ts` and
 * `inspect.mjs`), so `tool-call:` is invisible to all of them by construction,
 * and "which tool" stays recoverable from the one field that already names the
 * row.
 */
const TOOL_RESULT_PREFIX = 'tool'
const TOOL_CALL_PREFIX = 'tool-call'

/**
 * Reduce an untrusted name to a label-safe identifier: drop every character
 * outside `disallowed`'s complement, then bound the length.
 *
 * ONE function for every dynamic label segment, on purpose. Both segments
 * that exist — a subagent's sender id and a tool's name — are attacker- or
 * plugin-supplied strings that end up in a prompt, in `conversations.label`,
 * and in evidence excerpts, so they answer to the same rule; the only thing
 * that differs is which characters are legitimate for that kind of name. Two
 * hand-written strip expressions would be two places to fix the next time
 * that rule changes, and the `tool:` branch already demonstrated the failure
 * mode: it was written without the strip that its sibling had.
 * @param value - the untrusted name.
 * @param disallowed - global regex matching characters to remove.
 * @param max - maximum length kept.
 * @returns the sanitized segment, possibly empty (callers must degrade).
 */
const labelSegment = (value: string, disallowed: RegExp, max: number): string =>
  value.replace(disallowed, '').slice(0, max)

const textOf = (content: readonly { type: string; text?: string }[]): string =>
  content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

/**
 * Label a child's message with WHICH child sent it, so "who said this" stays
 * recoverable from L0 alone. The sender id rides the existing `label` column
 * rather than a new one: attribution is part of naming the row, and a second
 * column would let label and sender disagree.
 * @param source - the classified message source, possibly carrying a sender.
 * @returns `subagent:<id prefix>`, degrading to `subagent` when unattributed.
 */
const subagentLabel = (source: object): string => {
  const sender = 'senderSessionId' in source ? source.senderSessionId : undefined
  if (typeof sender !== 'string') return 'subagent'
  // Strip anything not id-shaped BEFORE it can reach a prompt. The label is
  // not decoration: it is the field that tells the extract model WHO an
  // event came from, and the prompt says those fields select trust
  // downstream. It is also persisted into `conversations.label` and copied
  // into evidence excerpts, so a name that carries markup outlives the turn.
  // Every sender is a UUID today and none of that is reachable — but "the ids
  // happen to be safe right now" is a runtime fact, not an invariant, and
  // this module's rule is to fail closed.
  const id = labelSegment(sender, SENDER_ID_CHARS, SENDER_ID_PREFIX)
  return id === '' ? 'subagent' : `subagent:${id}`
}

/**
 * Label a tool event with WHICH tool it names, under the given family prefix.
 *
 * The name reaches us from the `tool/call` event, i.e. from whatever plugin
 * or MCP server registered the tool — not from a fixed list this module
 * controls — so it is exactly as untrusted as a sender id and goes through
 * the same reduction. It degrades to `<prefix>:unknown`, which is also what an
 * unresolved call id has always produced: an unnamable tool and an
 * unrepresentable name are the same fact, so they get the same label.
 *
 * The prefix is a PARAMETER rather than a second function because the request
 * and the result answer to one rule — same charset, same length cap, same
 * degradation — and the only thing that differs is which family the row joins.
 * Writing `\`tool-call:${…}\`` at the second call site would be the D7–D9
 * failure in miniature: two prefix concatenations, one of which stops being
 * sanitized the day the rule changes. That exact regression already happened
 * once here (see `labelSegment`).
 *
 * `name` is typed `unknown` and coerced HERE, once, for the same reason. The
 * platform's type says `string`, but a type is a claim about the producer, not
 * a guarantee about the bytes — and this name arrives from whatever plugin or
 * MCP server registered the tool, which this module's own comments already
 * call as untrusted as a sender id. A non-string reaching `labelSegment` calls
 * `.replace` on it and throws, and a throw here is not a lost label: capture
 * builds a WHOLE TURN, so it takes that turn's entire L0 with it, the user's
 * own message included, behind `auto-extract.ts`'s fail-open catch. That is
 * the same failure shape as the deeply nested `arguments` (see
 * `summarizeArguments`), and it is fixed in the same direction — total
 * function, existing degradation, no second recovery path.
 *
 * Coercing at the two CALL SITES instead was the obvious alternative and is
 * rejected: it is one rule written twice, and the sibling site would be the
 * one to lose it. `tool/result` demonstrates exactly that — its `?? ''` looks
 * like a guard but only covers nullish, so a numeric name sailed past it into
 * the same throw.
 * @param prefix - the label family (`tool` for results, `tool-call` for requests).
 * @param name - the raw registered tool name: possibly empty, hostile, or not
 *   a string at all.
 * @returns `<prefix>:<safe name>`, degrading to `<prefix>:unknown`.
 */
const toolLabel = (prefix: string, name: unknown): string => {
  // Anything that is not a string degrades to the empty name rather than being
  // stringified: `String({})` would put `[object Object]` in the label, and a
  // label is an identifier — an unnamable tool and an unrepresentable name are
  // the same fact, so they get the same `unknown` that an unresolved call id
  // has always produced.
  const safe = typeof name === 'string' ? labelSegment(name, TOOL_NAME_CHARS, TOOL_NAME_MAX) : ''
  return `${prefix}:${safe === '' ? 'unknown' : safe}`
}

/**
 * Summarise a tool call's `arguments` into ONE bounded, structured line.
 *
 * ## Why the raw string is not an option
 *
 * `tool/call.data.arguments` is, by the platform's own definition, the JSON
 * string the model produced, unparsed. It is unbounded: measured across this
 * machine's real session logs, ~13.7k calls average 602 characters and run to
 * 52713. Storing it raw would not merely cost bytes — it would cost EXTRACT
 * INPUT, which is the thing this whole fix exists to increase. Replayed over
 * the real sessions, counting the events that actually fit
 * `EXTRACT_TRANSCRIPT_CHARS`, the three shapes rank:
 *
 *     raw arguments            FEWER events than capturing nothing at all
 *     first 400 characters     the same, and for the same reason
 *     this summary             more
 *
 * Both rejected shapes lose because a long `arguments` is long in ONE value —
 * a file body, a shell heredoc, a whole document — and a head-truncation keeps
 * exactly that value while cutting away the field names after it. The call is
 * then recorded as "write_file, and here are the first 400 characters of the
 * content", which is the least informative 400 characters available: it costs a
 * full row and does not even say which path was written.
 *
 * ## What is kept
 *
 * Short values verbatim, long values as a length placeholder:
 *
 *     {"query":"budget container","kind":"fact"}
 *     {"content":"<4821 chars>","file_path":"src/a.ts"}
 *
 * The structure is what extraction can use — which tool, against which target,
 * with which flags — and a 4821-character body was never going to survive any
 * budget anyway. `<N chars>` is deliberately a MEASUREMENT rather than an
 * ellipsis: "there was a 4821-character payload here" is a fact the model can
 * reason about, while "…" is an invitation to guess what was cut.
 *
 * Values are elided at `TOOL_CALL_VALUE_CHARS` and the finished line is capped
 * at `EXTRACT_EVENT_EXCERPT_CHARS` — see those constants for where the two
 * numbers come from. The row cap is enforced HERE, not merely asserted: with
 * enough short fields a summary can still exceed it (measured: 2 calls in
 * 13721), and a capture that quietly stores more than extraction can ever read
 * is storage spent on nothing.
 *
 * Non-object `arguments` (117 real cases, all of them the empty string from
 * zero-parameter tools like `list_agents`) fall back to eliding the raw string,
 * so the function is total: an unparseable argument list is still a fact worth
 * recording, and this must never throw on the capture path.
 *
 * "Total" is enforced by wrapping the WHOLE construction, because `JSON.parse`
 * is not the only member of it that throws. `JSON.stringify` recurses, so a
 * deeply nested value overflows the stack — measured on this Node: a value
 * nested ~4500 deep parses fine and then throws `RangeError` on the way back
 * out. A `try` around the parse alone therefore protected the wrong half. The
 * failure was not academic in kind, only in reach: `collectTurnEvents` builds a
 * whole turn, so ONE such call took the entire turn's L0 down with it —
 * including the user's own message — leaving a single `warn` from
 * `auto-extract.ts`'s fail-open catch and no record that anything was said.
 *
 * Real `arguments` nest at most 5 deep (13961 calls), so nothing reachable
 * today comes close. That is exactly why the guard belongs here rather than in
 * a validator upstream: this module's stated rule is to fail closed on
 * attacker-reachable input, and `arguments` is by the platform's own definition
 * a string the model produced — which an earlier prompt injection can shape.
 * "No real input does this yet" is a runtime fact, not an invariant.
 *
 * The degradation is the EXISTING one — `bound(elide(raw))`, the same path a
 * non-JSON argument string already took — not a second recovery route invented
 * for this case. A summary that cannot be built is the same fact as an argument
 * list that cannot be parsed: we know how long it was and nothing else.
 * @param raw - the model-produced argument string, exactly as the platform saw it.
 * @returns a single line, at most `EXTRACT_EVENT_EXCERPT_CHARS` characters.
 */
const summarizeArguments = (raw: string): string => {
  const elide = (value: string): string =>
    value.length > TOOL_CALL_VALUE_CHARS ? `<${value.length} chars>` : value
  const bound = (line: string): string =>
    line.length > EXTRACT_EVENT_EXCERPT_CHARS ? `<${raw.length} chars>` : line

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return bound(elide(raw))
    }
    const summary: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Non-strings are re-serialized before measuring, so a nested object is
      // priced by what it would actually take to write down rather than by
      // `[object Object]`. This is the call that recurses.
      summary[key] = elide(typeof value === 'string' ? value : JSON.stringify(value) ?? 'null')
    }
    return bound(JSON.stringify(summary))
  } catch {
    return bound(elide(raw))
  }
}

/**
 * Event category → provenance (spec §2.4). This mapping IS the injection
 * safety boundary: it must be total, and everything unmapped is tool-output
 * because unknown means lowest trust (fail closed).
 * @param event - one in-turn session event.
 * @param toolNameOf - resolves a tool call id to its tool name.
 * @returns the classified entry, or `undefined` for events carrying no content.
 */
const classify = (
  event: SessionEvent,
  toolNameOf: (callId: string) => string,
): Omit<TranscriptEvent, 'seq'> | undefined => {
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source
      const text = textOf(event.data.content)
      // Discriminate on `kind` alone (see SUBAGENT_SOURCE_KINDS): the previous
      // `plugin` + `form === 'relay'` test named a combination no plugin
      // actually emits (the type permits it; a survey of real sessions found
      // it zero times), so it was dead code, and every real child report fell
      // through to `tool-output`, indistinguishable from bash stdout.
      if (source.kind === 'user') return { label: 'user', text, provenance: 'human' }
      if (SUBAGENT_SOURCE_KINDS.has(source.kind)) {
        return { label: subagentLabel(source), text, provenance: 'subagent' }
      }
      // Everything else — plugin, goal, agent-instructions, coordinator, and
      // any kind added after this was written — is lowest trust. Unknown means
      // unproven, so the default must be the floor, not a guess.
      return { label: 'context', text, provenance: 'tool-output' }
    }
    case 'assistant/message':
      // Deliberately UNCHANGED, and the change that was proposed here is
      // recorded so it is not re-proposed: capturing the assistant message's
      // own `tool-call` content blocks (so a text-less assistant message would
      // stop being dropped) was rejected. Measured across every real session
      // on this machine, all 13715 such blocks carry `arguments` BYTE-IDENTICAL
      // to their `tool/call` event — so capturing them would be a second
      // implementation of one fact, and the weaker one: the block has no
      // `callId` pairing of its own and no provenance story separate from the
      // event's. The `tool/call` branch below is where an agent's action is
      // recorded, once.
      return {
        label: 'assistant',
        text: textOf(event.data.message.content),
        provenance: 'parent-agent',
      }
    case 'tool/call':
      return {
        label: toolLabel(TOOL_CALL_PREFIX, event.data.name),
        // Both untrusted fields are narrowed the same way, and neither is
        // `String()`-coerced. `String(undefined)` yields the literal text
        // "undefined", which would record a call as having had an argument
        // list that said `undefined` — a fabricated fact, and the one thing
        // L0 must never contain. A non-string argument list is instead the
        // empty one, which `summarizeArguments` already degrades honestly.
        text: summarizeArguments(typeof event.data.arguments === 'string' ? event.data.arguments : ''),
        // ALWAYS `tool-output`, never `parent-agent`, even though the text
        // originates with the model rather than with a tool (spec §2.4 fail
        // closed). `arguments` is the model's raw unparsed output, which means
        // a prompt injection carried in earlier tool output can steer what
        // lands here — and `parent-agent` is one of the three provenances in
        // §2.3's DEFAULT injection set. Trusting it would open a path from
        // "text an attacker can influence" straight into the packet injected
        // on every turn, which is the single boundary this module exists to
        // hold. The request is recorded for what it is: a fact about what was
        // asked for, at the trust level of the least trustworthy thing that
        // could have shaped it.
        provenance: 'tool-output',
      }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const name = toolNameOf(String(block.toolCallId))
      return {
        label: toolLabel(TOOL_RESULT_PREFIX, name),
        // Trust still keys off the RAW name against a fixed set of exact
        // literals: sanitizing first could only ever fold a hostile name onto
        // one of them, which is the direction that grants trust.
        text: textOf(block.content as { type: string; text?: string }[]),
        provenance: SUBAGENT_TOOL_NAMES.has(name) ? 'subagent' : 'tool-output',
      }
    }
    default:
      return undefined
  }
}

/** Collect one turn's content-bearing events, each classified by category. */
export const collectTurnEvents = (
  events: readonly SessionEvent[],
  turn: number,
): TranscriptEvent[] => {
  let inTurn = false
  const callNames = new Map<string, string>()
  const out: TranscriptEvent[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      inTurn = event.data.turn === turn
      continue
    }
    if (event.type === 'turn/end') {
      if (event.data.turn === turn) break
      continue
    }
    if (!inTurn) continue
    // A `tool/call` still feeds the call-id → name map that `tool/result`
    // reads, and it now ALSO classifies into a row of its own. It used to do
    // only the first and `continue`, which is how L0 ended up recording what
    // every tool said while recording not one thing the agent did: measured on
    // this repo's own `session-43422ed9`, 863 calls discarded against 878
    // results kept, i.e. every stored result was an orphan with no request.
    if (event.type === 'tool/call') callNames.set(String(event.data.callId), event.data.name)
    const entry = classify(event, (callId) => callNames.get(callId) ?? '')
    if (entry !== undefined && entry.text.trim() !== '') out.push({ seq: event.seq, ...entry })
  }
  return out
}
/**
 * Minimum trust across the cited seqs (spec §2.4). An empty citation list and
 * an unknown seq both mean the same thing — no proven source — and both land
 * on `tool-output`, the lowest trust (fail closed).
 */
export const provenanceFor = (
  seqs: readonly number[],
  bySeq: ReadonlyMap<number, { readonly provenance: Provenance }>,
): Provenance => {
  if (seqs.length === 0) return 'tool-output'
  const cited = seqs.map((seq) => bySeq.get(seq)?.provenance ?? 'tool-output')
  return cited.reduce((lowest, next) =>
    PROVENANCE_PRIORITY[next] < PROVENANCE_PRIORITY[lowest] ? next : lowest,
  )
}
