/**
 * Identity predicates (spec §3.1, D1). Two predicates, both required for
 * writes:
 *
 * - `isLiveAgent`: the exact object the registry currently serves (anti-forgery);
 * - `isLineagePrincipal`: durable permission semantics from platform-owned
 *   session facts. NOT "no parentSession" — ordinary user forks carry
 *   parentSession too (dsh-session fork() inherits cwd/parentSession/seedLength
 *   only). The subagent creation path alone stamps `origin:'subagent'` and
 *   `delegationDepth>=1`, and `delegationDepthOf` takes max(header, runtime)
 *   so a resumed former subagent that became a runtime root keeps its depth.
 * @module @strataloom/dsh-memory/identity
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

/** Anti-forgery: only the registry's own live object counts. */
export const isLiveAgent = (ctx: Context, agent: Agent): boolean =>
  ctx.agents.get(agent.id) === agent

/** Durable principal lineage — platform-sourced facts only (never caller claims). */
export const isLineagePrincipal = (agent: Agent): boolean =>
  delegationDepthOf(agent) === 0 && agent.session.header.origin !== 'subagent'
