/**
 * `/memory` — the human's view of what the plugin has been remembering.
 *
 * This exists because the plugin learns SILENTLY: a turn ends, the pipeline
 * distils it, and a memory appears that nobody asked for. That is the feature,
 * and it is also the reason a person needs a way to see the result without
 * having to guess a search term first — `memory_recall` answers "is X stored?",
 * and the question here is "what have you stored?".
 *
 * It is a command rather than a UI panel because a command already runs inside
 * an agent context: `CommandInvocation` carries the exact live agent, so the
 * same D1 predicates that guard the tools guard this, with no second permission
 * path and no way for a caller to assert who it is. A panel would need a
 * read API reachable without an agent, which is precisely what D1 forbids.
 * @module @strataloom/dsh-memory/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { MemoryAccessError, MemoryInputError, type MemoryService } from './service.ts'
import type { MemoryId, MemoryListingScope } from './types.ts'
import { LIST_LIMIT } from './constants.ts'

/**
 * Register `/memory` when the platform offers commands; disposal rides the
 * plugin fiber.
 *
 * A SOFT dependency, like `llm` and `approval`: a deployment without the
 * command runtime keeps its memories, its injection and its pipeline, and
 * simply has no `/memory`. Listing it in `inject` would make a convenience
 * command able to stop the whole plugin from activating.
 */
export const registerCommand = (ctx: Context, memory: MemoryService): void => {
  const commands = ctx.get('commands')
  if (commands === undefined) return
  commands.register({
    name: 'memory',
    description: 'Show what is remembered here; `/memory forget <id>` removes one.',
    input: { hint: '[forget <id>]' },
    handler: async ({ agent, rawInput }) => {
      const input = rawInput.trim()
      try {
        if (input === '') return { kind: 'success', text: await renderList(memory, agent) }

        const [verb, ...rest] = input.split(/\s+/)
        if (verb !== 'forget') {
          return { kind: 'error', text: `unknown: /memory ${verb}. Use /memory or /memory forget <id>.` }
        }
        const id = rest.join(' ').trim()
        if (id === '') return { kind: 'error', text: 'usage: /memory forget <id>' }

        const report = await memory.forget(id as string as MemoryId, agent)
        return { kind: 'success', text: report.note }
      } catch (error) {
        // Refusals are already phrased for a person ("only the principal agent
        // may…", "no memory with id…"); anything else is a disk or database
        // fault whose internals help nobody reading a chat.
        if (error instanceof MemoryInputError || error instanceof MemoryAccessError) {
          return { kind: 'error', text: error.message }
        }
        ctx.logger.warn('strataloom: /memory failed:', error)
        return { kind: 'error', text: 'the memory store is unavailable right now' }
      }
    },
  })
}

const SCOPE_LABEL = {
  repo: 'This repository',
  personal: 'Everywhere (personal)',
} as const

/**
 * A group member is labelled with its source and, when archived, said so out
 * loud: those entries cannot be forgotten from here (no checkout exists), and
 * the footer offers `forget` unconditionally. A heading that hid the
 * distinction would send the reader to a refusal.
 */
const scopeLabel = (scope: MemoryListingScope): string =>
  scope.kind === 'group'
    ? `${scope.source}${scope.archived ? ' (archived — read-only, no checkout here)' : ' (group member — read-only here)'}`
    : SCOPE_LABEL[scope.kind]

/**
 * Render the listing. Ids are shown because the only action offered needs one,
 * and bodies are truncated because this is an index, not a reader — the whole
 * text stays reachable through `memory_recall`.
 */
const renderList = async (
  memory: MemoryService,
  agent: Parameters<MemoryService['list']>[0],
): Promise<string> => {
  const listings = await memory.list(agent, LIST_LIMIT)
  const total = listings.reduce((sum, listing) => sum + listing.memories.length, 0)
  if (total === 0) {
    return 'Nothing remembered yet. Memories appear as you work, or when you ask me to remember something.'
  }
  const lines: string[] = []
  for (const { scope, memories } of listings) {
    if (memories.length === 0) continue
    lines.push(`${scopeLabel(scope)} — ${memories.length}`)
    for (const memory of memories) {
      const body = memory.body.replace(/\s+/g, ' ')
      const shown = body.length > 100 ? `${body.slice(0, 100)}…` : body
      lines.push(`  [${memory.kind}] ${memory.title}`)
      lines.push(`      ${shown}`)
      lines.push(`      ${memory.id}`)
    }
    lines.push('')
  }
  lines.push('Remove one with `/memory forget <id>`, or just tell me to forget it.')
  return lines.join('\n')
}
