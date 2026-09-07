/**
 * Batch reconcile job (spec §3.4/§5.2): one extract's whole candidate batch,
 * one LLM call, one commit. The job decides keep/drop/replace only; content is
 * the extract's.
 *
 * Whether a candidate replaces an existing memory is decided by their
 * RELATION, not by their kind — the prompt asks whether both could be followed
 * at once. Kind survives in exactly one place downstream: a replaced
 * `procedure` becomes `archived` rather than `superseded`, because the old
 * sequence still describes what used to work.
 * @module @strataloom/dsh-memory/pipeline/reconcile
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OpenStore } from '../store/store.ts'
import { LAYER, type MemoryKind } from '../types.ts'
import { RECONCILE_EXISTING_LIMIT } from '../constants.ts'
import { queryAllMemories } from '../store/fts.ts'
import { callPipelineLlm, parseStrictJson, PipelineLlmError, type PinnedRoute } from './llm-call.ts'
import { reconcileSystemPrompt } from './prompts.ts'
import { commitClaimedJob, type ClaimedJob } from './jobs.ts'
import type { ReconcilePayload } from './extract.ts'

interface CandidateRow {
  readonly id: string
  readonly kind: MemoryKind
  readonly title: string
  readonly body: string
}

/**
 * A validated decision. The union makes `supersedes` present exactly when the
 * action needs it, so the apply loop cannot forget the absent case — the
 * parser is the only place that check lives.
 */
type Decision = { readonly candidateIndex: number } & (
  | { readonly action: 'activate' | 'drop' }
  | { readonly action: 'supersede'; readonly supersedes: string }
)

const parseDecisions = (raw: unknown, count: number): Decision[] => {
  const root = raw as { decisions?: unknown }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.decisions)) {
    throw new PipelineLlmError('reply missing decisions array')
  }
  const seen = new Set<number>()
  const out: Decision[] = []
  for (const item of root.decisions) {
    const { candidateIndex: index, action, supersedes } = item as Record<string, unknown>
    if (
      typeof index !== 'number' ||
      index < 0 ||
      index >= count ||
      seen.has(index) ||
      (action !== 'activate' && action !== 'drop' && action !== 'supersede')
    ) {
      throw new PipelineLlmError('malformed decision in reply')
    }
    seen.add(index)
    if (action === 'supersede') {
      if (typeof supersedes !== 'string') {
        throw new PipelineLlmError('supersede decision missing supersedes id')
      }
      out.push({ candidateIndex: index, action, supersedes })
    } else {
      out.push({ candidateIndex: index, action })
    }
  }
  if (seen.size !== count) throw new PipelineLlmError('decisions must cover every candidate exactly once')
  return out
}

/**
 * Run one claimed reconcile job to its single commit. Candidates whose row
 * vanished (forgotten meanwhile) or whose decision no longer applies are
 * dropped silently — the durable state is authoritative, not the reply.
 */
export const runReconcileJob = async (
  ctx: Context,
  store: OpenStore,
  job: ClaimedJob,
  payload: ReconcilePayload,
  signal: AbortSignal,
): Promise<void> => {
  const fetchCandidate = store.db.prepare(
    `SELECT id, kind, title, body FROM memories WHERE id = ? AND status = 'candidate'`,
  )
  const candidates: CandidateRow[] = []
  for (const id of payload.candidateIds) {
    const row = fetchCandidate.get(id) as CandidateRow | undefined
    if (row !== undefined) candidates.push(row)
  }
  if (candidates.length === 0) {
    commitClaimedJob(store, job.id, job.leaseToken, () => {})
    return
  }

  // The set the model dedupes against is the STORED memories, so the derived
  // layer must not appear in it. A scenario block or portrait is a generated
  // restatement of rows already in this list, and offering it as if it were a
  // stored memory corrupts both decisions the model can make about it:
  //
  //   drop      — a summary legitimately restates the memory it summarizes, so
  //               a candidate matching one looks like a duplicate. The
  //               candidate is marked `superseded`, and the D9 invalidation
  //               trigger then deletes the summary on the very next write to
  //               the layer's source set (`active` + INJECTABLE provenance),
  //               so the thing it was judged a duplicate OF does not survive
  //               either. Measured end to end against the unfixed query: the
  //               candidate's own wording is left in no active row at all
  //               (`workspaces`: 1 row, status `superseded`). Decay makes this
  //               strictly worse rather than better: its UPDATE of raw rows to
  //               `dormant` moves them OUT of the source set, and D9's UPDATE
  //               trigger tests OLD as well as NEW, so at v12 that DEPARTURE
  //               still fires it — `invalidate_derived_update` deletes the
  //               whole derived layer
  //               in the same statement (measured: 1 derived row before, 0
  //               after a decay that slept 55 raw rows). The summary is
  //               therefore never a lasting carrier of anything — which is
  //               precisely why letting a candidate be dropped against one
  //               loses the write.
  //   supersede — a decision naming a derived id passes the `status='active'`
  //               guard below (derived rows ARE active), so `supersedeOld`
  //               reports changes=1 (measured directly) while the RAW row the
  //               model meant to replace stays active with
  //               `superseded_by = NULL`. Measured through this function: two
  //               contradictory active `fact` rows, the model's intent
  //               discarded without a trace.
  //
  // This REUSES `queryAllMemories` rather than restating its predicate with an
  // added `AND derived = LAYER.RAW`, because a rule written twice is the
  // defect: that function already selects these four columns under exactly this
  // predicate and order, and its documented subject — everything a person
  // should be able to see — is the same question reconcile asks. Verified
  // row-for-row identical to the corrected inline SQL on every live production
  // store. Deliberately not `queryInjectableSet`: reconcile dedupes against
  // everything STORED, and that one hides `subagent`/`tool-output` rows and
  // reorders by provenance priority — a candidate duplicating a hidden row
  // would be activated as new.
  const existing = queryAllMemories(store, RECONCILE_EXISTING_LIMIT)

  // Candidates are addressed by array index (their ids are internal and the
  // model has no use for them); existing rows keep their id because a
  // supersede decision must name one.
  const userPrompt = JSON.stringify({
    candidates: candidates.map(({ kind, title, body }) => ({ kind, title, body })),
    existing,
  })

  const route: PinnedRoute = { provider: payload.provider, model: payload.model }
  const reply = await callPipelineLlm(ctx, route, reconcileSystemPrompt(), userPrompt, signal)
  const decisions = parseDecisions(parseStrictJson(reply), candidates.length)

  const now = Date.now()
  commitClaimedJob(store, job.id, job.leaseToken, () => {
    // Activation is a pure status flip: the extract model already wrote the
    // content and this job's question is only keep/drop/replace. Letting
    // reconcile reword would re-do finished semantic work (the same reason
    // explicit propose skips reconcile entirely, spec §3.3) and would need a
    // second copy of the truncation rules.
    const activate = store.db.prepare(
      `UPDATE memories SET status = 'active', updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    )
    // ⚠️ WRITES NO `superseded_by`, AND THAT ABSENCE IS LOAD-BEARING.
    //
    // A dropped candidate goes `candidate -> superseded` WITHOUT ever having
    // been active: nothing replaced it, so there is no id to point at. That
    // makes the null pointer the only thing distinguishing these rows from the
    // ones `supersedeOld` below writes, which DID leave 'active' and DO carry a
    // pointer. `metrics.ts`'s `REJECTED_CANDIDATE_SQL` reads exactly that
    // difference, so `overturnRate` counts real overturns and not the pipeline
    // correctly refusing noise — before it did, the metric rose as the system
    // got healthier (measured across the nine live stores: 2.0-2.3x too high on
    // the two with real pipeline traffic, 1.4x on a third holding one such row,
    // and unchanged on the six that hold none).
    //
    // So: giving this statement a pointer is not a cosmetic addition. It would
    // merge the two populations back together and silently restore that
    // inversion. Stated as a comment rather than a CHECK constraint because
    // widening the status enum needs a full-table rebuild of `memories` — see
    // `REJECTED_CANDIDATE_SQL` for why that was rejected. TWO mutation-covered
    // tests in `test/layers.test.mjs` pin the shape ("overturnRate counts
    // overturned memories…" and "overturnRate counts an archived procedure…"):
    // measured, giving this statement a pointer moves the suite from its
    // baseline failure count to BASELINE + 2, and those two names are the whole
    // of the addition — each dies on its `superseded_by === null` discriminant
    // before the rate is read. Stated as a delta rather than as "the other N
    // stayed green" because the machine it was measured on (Windows) carries
    // six platform-only failures in its baseline and so has no all-green count
    // to quote. Nothing in the schema does any of this.
    const drop = store.db.prepare(
      `UPDATE memories SET status = 'superseded', updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    )
    const supersedeOld = store.db.prepare(
      `UPDATE memories SET status = ?, superseded_by = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    )
    for (const decision of decisions) {
      const candidate = candidates[decision.candidateIndex]
      if (candidate === undefined) continue
      if (decision.action === 'drop') {
        drop.run(now, candidate.id)
        continue
      }
      if (decision.action === 'supersede') {
        const oldRow = store.db
          .prepare(`SELECT kind, status, derived FROM memories WHERE id = ?`)
          .get(decision.supersedes) as
          | { kind: MemoryKind; status: string; derived: number }
          | undefined
        // TWO eligibility rules, stated so a new kind inherits both rather than
        // needing a branch. Neither asks what KIND the target is: a DERIVED
        // target is not a memory to supersede at all (it is a generated
        // restatement of rows already in this list, and `forget`/`share` refuse
        // one by name for the same reason); and a vanished or inactive target
        // degrades to plain activation — durable state outranks the reply.
        //
        // WHAT IS NOT HERE, AND WHY. A third clause `oldRow.kind !==
        // 'preference'` used to stand between these two, so a supersede
        // decision naming a preference silently degraded to activation. It was
        // removed (A4) because it made the code answer a SEMANTIC question —
        // "is this new wording a replacement or a rival?" — with a syntactic
        // one, and it answered wrong by construction. Measured across the nine
        // stores on this machine before the removal: `preference` 57 rows with
        // `superseded_by` non-null in 0 of them, against 593 non-preference
        // rows with 49 hits. A structural zero, not a rate.
        //
        // Those same 49 pointers also settle what the removed clause implied
        // about kind generally: 45 join rows of the SAME kind and 4 cross it
        // (`procedure -> coding` ×3, `procedure -> fact` ×1). So kind was never
        // a fence around supersede — this pipeline had already crossed it four
        // times, and only `preference` was walled off. The cross-kind cases all
        // carry pipeline provenance rather than the `principal-explicit` that
        // `propose({replaces})` writes, so they came through here, not by hand.
        //
        // The model was not failing to SEE the duplicates. One store holds 13
        // `preference` rows in status `superseded`, every one of them with
        // `superseded_by IS NULL` and a lifetime of 11-41 seconds between
        // `created_at` and `updated_at` — i.e. each was a CANDIDATE the model
        // chose to drop, never an active row that was replaced. The model
        // recognised the restatement 13 times and had only two outcomes
        // available: discard the new wording, or store a second copy beside the
        // old one. "Replace the old with the new" was the outcome the code
        // withheld.
        //
        // This is not a safety rule being relaxed. `service.propose({replaces})`
        // supersedes with `WHERE id = ? AND status = 'active' AND derived =
        // RAW` and NO kind clause, so an explicit save has always been able to
        // supersede a preference. The removal makes the two writers agree
        // instead of leaving the guarantee true on one path and false on the
        // other.
        //
        // The judgement itself now lives entirely in `reconcileSystemPrompt`,
        // which asks whether both memories could be FOLLOWED AT ONCE (a
        // contradiction keeps both; a restatement replaces) and breaks a tie
        // toward "activate". Code cannot decide that question, and the branch
        // it replaced only looked like it could.
        //
        // The `derived` clause is an eligibility test, NOT a second copy of the
        // v11 `guard_derived_status` trigger. The trigger states an INVARIANT —
        // which states the data may be in, enforced against every writer
        // including ones not yet written. This expression answers a different
        // question the job must answer anyway: is the row the reply NAMED a
        // legitimate target? That question already had two clauses here, and a
        // derived id fails it for the same reason an archived one does. The
        // distinction is observable in the failure mode, which is why the
        // clause earns its place rather than merely duplicating: without it a
        // reply naming a derived id makes the trigger ABORT, and because the
        // whole batch is one commit (D6) that rolls back EVERY candidate in it
        // — measured, including candidates whose own decisions were fine — then
        // burns the job's retries to a dead letter. With it, the decision
        // degrades to plain activation on the path already written for a target
        // that cannot be superseded. ADR 0006's rule is that a failure in one
        // chore must not take down work that is independently fine; a batch
        // aborted over one bad id is that same connected failure inside a job.
        //
        // Reachability, stated honestly: no production writer reaches this
        // today. Since `15b80b7` the `existing` set comes from
        // `queryAllMemories`, which filters `derived = LAYER.RAW`, so the model
        // is never SHOWN a derived id (measured: the offered set holds the raw
        // row only). This is the guard for a reply that names one anyway, and
        // for a future change that re-widens that window.
        //
        // Everything else is replaced, and the replaced row is
        // `archived` when it was a `procedure` (superseding a procedure is
        // versioning — the old sequence still describes what used to work)
        // and `superseded` otherwise, including `coding`: a corrected
        // engineering lesson means the old one was wrong, not merely older.
        //
        // No cycle check is needed: `superseded_by` is only ever written on a
        // row leaving 'active', pointing at a row entering 'active' from
        // 'candidate', and nothing ever transitions back INTO 'candidate'.
        // Every id is written at most once, so the graph cannot close a loop.
        if (oldRow?.status === 'active' && oldRow.derived === LAYER.RAW) {
          supersedeOld.run(
            oldRow.kind === 'procedure' ? 'archived' : 'superseded',
            candidate.id,
            now,
            decision.supersedes,
          )
        }
      }
      activate.run(now, candidate.id)
    }
  })
}
