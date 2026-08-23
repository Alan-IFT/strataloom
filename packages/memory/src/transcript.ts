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

/** Tool names whose results are subagent relays, not plain tool output. */
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'subagent_fork'])

const textOf = (content: readonly { type: string; text?: string }[]): string =>
  content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')


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
      if (source.kind === 'user') return { label: 'user', text, provenance: 'human' }
      if (source.kind === 'plugin' && 'form' in source && source.form === 'relay') {
        return { label: 'subagent-relay', text, provenance: 'subagent' }
      }
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
        label: `tool:${name || 'unknown'}`,
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
