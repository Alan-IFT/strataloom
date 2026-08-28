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
 * Label a tool result with WHICH tool produced it.
 *
 * The name reaches us from the `tool/call` event, i.e. from whatever plugin
 * or MCP server registered the tool — not from a fixed list this module
 * controls — so it is exactly as untrusted as a sender id and goes through
 * the same reduction. It degrades to `tool:unknown`, which is also what an
 * unresolved call id has always produced: an unnamable tool and an
 * unrepresentable name are the same fact, so they get the same label.
 * @param name - the raw registered tool name, possibly empty or hostile.
 * @returns `tool:<safe name>`, degrading to `tool:unknown`.
 */
const toolLabel = (name: string): string => {
  const safe = labelSegment(name, TOOL_NAME_CHARS, TOOL_NAME_MAX)
  return `tool:${safe === '' ? 'unknown' : safe}`
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
      return {
        label: 'assistant',
        text: textOf(event.data.message.content),
        provenance: 'parent-agent',
      }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const name = toolNameOf(String(block.toolCallId))
      return {
        label: toolLabel(name),
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
    if (event.type === 'tool/call') {
      callNames.set(String(event.data.callId), event.data.name)
      continue
    }
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
