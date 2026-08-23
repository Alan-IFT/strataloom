/**
 * Pipeline LLM call surface (spec §5.3): `ctx.llm.stream()` consumed fully —
 * aggregate text deltas, check the terminal finish (error/aborted are
 * failures), close the iterator. No `purpose` (the platform enum has no
 * memory purpose). Route: payload-pinned first; on its failure fall back ONCE
 * to `ctx.agentDefaultModel.currentSelection()` — the sole source of "current
 * default route".
 * @module @strataloom/dsh-memory/pipeline/llm-call
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { LLM_MAX_TOKENS } from '../constants.ts'

/** A pinned provider/model route from the job payload. */
export interface PinnedRoute {
  readonly provider: string
  readonly model: string
}

/** Loud pipeline-LLM failure (drives the retry exit — no half-products). */
export class PipelineLlmError extends Error {
  override name = 'StrataloomPipelineLlmError'
}

const streamOnce = async (
  ctx: Context,
  route: PinnedRoute,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> => {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new PipelineLlmError('llm service unavailable')
  const messages: Message[] = [
    createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }),
  ]
  let text = ''
  let finished = false
  const iterable = llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    maxTokens: LLM_MAX_TOKENS,
    signal,
  })
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      const chunk = next.value
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new PipelineLlmError(`stream finished as ${chunk.reason.kind}`)
        }
        finished = true
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined)
  }
  if (!finished) throw new PipelineLlmError('stream ended without a finish chunk')
  return text
}

/**
 * Call the pipeline model: pinned route first, then one fallback to the
 * current default selection (fail open — a logged-out pinned provider must
 * not 5x-fail into dead-letter; spec §5.3).
 */
export const callPipelineLlm = async (
  ctx: Context,
  pinned: PinnedRoute,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> => {
  try {
    return await streamOnce(ctx, pinned, system, user, signal)
  } catch (first) {
    if (signal.aborted) throw first
    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel === undefined) throw first
    const selection = defaultModel.currentSelection()
    if (selection.provider === pinned.provider && selection.model === pinned.model) throw first
    ctx.logger.warn(
      `strataloom: pinned route ${pinned.provider}/${pinned.model} failed; falling back to default`,
      first,
    )
    return await streamOnce(
      ctx,
      { provider: selection.provider, model: selection.model },
      system,
      user,
      signal,
    )
  }
}

/**
 * Parse a strict-JSON model reply. A fenced or prefixed reply is coaxed once
 * by slicing to the outermost braces; anything else is a retry-exit failure
 * (no half-products, spec §5.3).
 */
export const parseStrictJson = (raw: string): unknown => {
  const text = raw.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // fall through
      }
    }
    throw new PipelineLlmError('model reply is not valid JSON')
  }
}
