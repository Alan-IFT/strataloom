/**
 * Turn-boundary capture (spec §5.1 + L0 substrate).
 *
 * One listener, one classification pass, one transaction:
 *   1. classify the turn's events (the shared §2.4 mapping);
 *   2. persist them as L0 — this is unconditional, because the durable
 *      record of what was said must not depend on whether we happened to
 *      want to extract from it;
 *   3. enqueue extract IF the gates pass (principal, repo store, `llm`
 *      available, enough new text).
 *
 * Capture and enqueue share one transaction, so a queued job can always read
 * the exact turn it was queued for. Capture no longer needs `sessionQuery`:
 * the extract job reads our own L0 copy (see `pipeline/extract.ts`).
 * @module @strataloom/dsh-memory/auto-extract
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryService } from './service.ts'
import { isLineagePrincipal } from './identity.ts'
import { collectTurnEvents } from './transcript.ts'
import { captureTurn } from './store/conversations.ts'
import { enqueueJob, jobId } from './pipeline/jobs.ts'
import { PAYLOAD_VERSION, PROMPT_VERSION } from './pipeline/prompts.ts'
import type { ExtractPayload } from './pipeline/extract.ts'
import { ENQUEUE_MIN_TURN_TOKENS } from './constants.ts'

/** Install the turn-stopping listener (agent-level hook, principal-gated). */
export const installAutoExtract = (ctx: Context, memory: MemoryService): void => {
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      // Audience: only a principal's turns are this repo's conversation.
      if (!isLineagePrincipal(agent)) return
      const store = memory.storeFor(agent, true)
      if (store === undefined) return // no repo affiliation ⇒ nothing to record

      const events = collectTurnEvents(agent.session.events, turn)
      if (events.length === 0) return

      // The gate gets its token count from the SAME classified events, so
      // "what we measured" and "what we stored" can never disagree.
      const turnTokens = events.reduce(
        (sum, event) =>
          event.provenance === 'human' || event.provenance === 'parent-agent'
            ? sum + Math.ceil(event.text.length / 4)
            : sum,
        0,
      )
      const wantExtract =
        ctx.get('llm') !== undefined && turnTokens >= ENQUEUE_MIN_TURN_TOKENS

      store.tx(() => {
        captureTurn(store, agent.session.id, turn, events)
        if (!wantExtract) return
        const payload: ExtractPayload = {
          sessionId: agent.session.id,
          turn,
          provider: agent.options.provider ?? '',
          model: agent.options.model ?? '',
          promptVersion: PROMPT_VERSION,
          payloadVersion: PAYLOAD_VERSION,
        }
        enqueueJob(
          store,
          'extract',
          jobId('extract', store.repoKey, agent.session.id, turn),
          payload,
          Date.now(),
          true, // already inside this transaction
        )
      })
    } catch (error) {
      // Fail open: capture failure must never break the turn boundary.
      ctx.logger.warn('strataloom: turn capture failed:', error)
    }
  })
}
