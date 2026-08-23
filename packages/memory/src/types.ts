/**
 * Value objects shared by the Service, the tools, and the pipeline
 * (spec §3.2 — tool schemas and Service types have one source).
 * @module @strataloom/dsh-memory/types
 */

declare const MemoryIdBrand: unique symbol

/** Branded memory identity (spec §3.2). */
export type MemoryId = string & { readonly [MemoryIdBrand]: true }

/**
 * Content kinds and the judgement that picks each one — ONE definition.
 *
 * The name and its criterion are inseparable: a kind the model can select but
 * cannot tell apart is worse than no kind at all, because the classification
 * silently degrades into a guess and recall inherits the mistake. Keeping the
 * enum here and its prose in the tool description would be the same rule in
 * two places, and adding a kind would compile, pass every test, and expose an
 * unexplained option to the model (the shape of D7-D9).
 *
 * Criteria are written FOR THE MODEL — they must discriminate, not merely
 * describe. Adding a kind means answering "how does one tell it from the
 * others?" right here, or not adding it (spec §2.2 — content classification
 * only; scope lives in the physical store).
 */
export const MEMORY_KIND_CRITERIA = {
  // `fact` and `coding` are the pair most easily confused, so each criterion
  // names the OTHER and gives the one test that separates them: would this
  // still be true in a different repository? `fact` is stated first because
  // repo knowledge is the common case.
  fact: "true of THIS repo and false elsewhere — its layout, entry points, conventions, history",
  coding:
    'an engineering lesson that survives a change of repository — a verified fix, an ' +
    'approach that failed and why, a design rationale, a pitfall, a non-regression check',
  preference: 'how the user wants things done',
  procedure: 'a working sequence of steps',
} as const satisfies Record<string, string>

/** Content kinds — derived, so the type cannot list a kind with no criterion. */
export type MemoryKind = keyof typeof MEMORY_KIND_CRITERIA

/** The domain kind enum as a runtime tuple (schema CHECK and tool enum share it). */
export const MEMORY_KINDS = Object.keys(MEMORY_KIND_CRITERIA) as readonly MemoryKind[]

/* A blank criterion is the one way the pairing above can still be defeated:
   it satisfies the type while telling the model nothing. Cheap to assert at
   load, and it names the kind that caused it. */
for (const [kind, criterion] of Object.entries(MEMORY_KIND_CRITERIA)) {
  if (criterion.trim() === '') {
    throw new Error(`strataloom: memory kind ${JSON.stringify(kind)} has no criterion`)
  }
}

/** The model-facing rendering of every kind and its criterion. */
export const kindGuidance = (): string =>
  Object.entries(MEMORY_KIND_CRITERIA)
    .map(([kind, criterion]) => `${kind} (${criterion})`)
    .join(' | ')

/**
 * Which layer a row belongs to — the `derived` column, widened from a boolean
 * to a level so L2/L3 need no new table, column, or invalidation protocol.
 *
 * The values are ordered by distance from the raw record, and `RAW = 0` is
 * load-bearing: every query that asks "is this an original memory?" is written
 * `derived = 0`, and D9's triggers fire on `OLD/NEW.derived = 0`. Widening
 * therefore leaves both untouched, and each new layer inherits invalidation
 * for free — the dividend of stating that rule over the data rather than in
 * the writers (see docs/design/4x4-memory.md §1).
 *
 * An alternative `scenario_key` column was rejected: it would let one concept
 * (what this row is) be expressed by two fields, admitting states like
 * "whole-store summary carrying a scenario key" that then need a constraint to
 * forbid. A single widened column makes those unrepresentable.
 */
export const LAYER = {
  /** L1 — an original memory. Never produced by the rebuild job. */
  RAW: 0,
  /** A single briefing over the whole injectable set (the pre-L2 rollup). */
  SUMMARY: 1,
  /** L2 — one block per scenario, clustered by topic. */
  SCENARIO: 2,
  /** L3 — the cross-repo persona. Exactly one per user, in the global store. */
  PERSONA: 3,
} as const

/** Every derived layer, i.e. everything a rebuild may produce. */
export const DERIVED_LAYERS = [LAYER.SUMMARY, LAYER.SCENARIO, LAYER.PERSONA] as const

/**
 * Memory lifecycle states (spec §3.3). The runtime tuple is the source and
 * the type is derived, so the schema's CHECK and the code's type cannot list
 * different states.
 */
export const MEMORY_STATUSES = [
  'candidate',
  'active',
  'superseded',
  'dormant',
  'archived',
  'tombstone',
] as const

export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/**
 * Provenance enum (spec §2.4 — assignment paths are exhaustively
 * service-owned, D1/D3). Tuple first, type derived, for the same reason.
 */
export const PROVENANCES = [
  'human',
  'principal-explicit',
  'parent-agent',
  'subagent',
  'tool-output',
  'derived',
] as const

export type Provenance = (typeof PROVENANCES)[number]

/**
 * Provenances allowed into the default injection packet
 * (spec §2.3 content filter; subagent/tool-output are recall-only).
 */
export const INJECTABLE_PROVENANCE: readonly Provenance[] = [
  'human',
  'principal-explicit',
  'parent-agent',
]

/**
 * Injection ordering priority (higher first). human > principal-explicit >
 * parent-agent > the rest (spec §2.3).
 */
export const PROVENANCE_PRIORITY: Readonly<Record<Provenance, number>> = {
  human: 5,
  'principal-explicit': 4,
  'parent-agent': 3,
  subagent: 2,
  'tool-output': 1,
  derived: 0,
}

/** Statuses excluded from every read surface (spec §3.3 排除规则). */
export const EXCLUDED_STATUSES: readonly MemoryStatus[] = [
  'superseded',
  'tombstone',
  'archived',
  'candidate',
  // Dormant entries stay stored and revivable but leave every read surface —
  // that removal IS the point of decay. Revival happens in the decay batch,
  // never on a read (D4).
  'dormant',
]

/** Recall query (spec §3.2 — no level/derived parameters). */
export interface RecallQuery {
  readonly query: string
  readonly kind?: MemoryKind
}

/**
 * One memory as every read path returns it. Both queries (injection and
 * recall) select exactly these columns, so this is simultaneously the row
 * shape and the public hit shape — the status/provenance/timestamp columns
 * decide *which* rows come back and in what order, but no consumer reads
 * them, so fetching them would be work done to be discarded.
 */
export interface MemoryHit {
  readonly id: MemoryId
  readonly kind: MemoryKind
  readonly title: string
  readonly body: string
}

/** Public alias: what `recall()` hands back per hit. */
export type RecallHit = MemoryHit

/** Recall result — rendered by the tool within the §4.3 budget. */
export interface RecallResult {
  readonly hits: readonly RecallHit[]
}

/**
 * Where a memory belongs. `repo` is this checkout's knowledge; `personal` is
 * the cross-repo user profile (Personal Memory) — how the user wants to be
 * worked with, valid in every repository.
 *
 * Scope selects the physical store, and the store's guard derives visibility
 * from its own kind: a caller declares intent but can never assert
 * visibility itself (D1/D2).
 */
export type MemoryScope = 'repo' | 'personal'

/** The scope enum as a runtime tuple (tool schema and service share it). */
export const MEMORY_SCOPES = ['repo', 'personal'] as const

/** Candidate content for propose — no visibility/provenance fields by design (D1). */
export interface MemoryCandidate {
  readonly title: string
  readonly body: string
  readonly kind: MemoryKind
  /** Defaults to `repo` when omitted. */
  readonly scope?: MemoryScope
  /**
   * Id of an existing active memory this one supersedes. The caller model
   * decides equivalence — it can see the existing entries; code cannot judge
   * semantics and must not guess.
   */
  readonly replaces?: MemoryId
}

/**
 * What a save returns: the new id, plus any active memories that already
 * cover similar ground. The model uses `similar` to collapse duplicates via
 * `replaces` — surfacing the overlap is code's job, judging equivalence is
 * the model's.
 */
export interface ProposeResult {
  readonly id: MemoryId
  readonly similar: readonly MemoryHit[]
}

/** Result of a share attempt (spec §12 projection). */
export interface ShareReport {
  readonly id: MemoryId
  readonly shared: boolean
  readonly note: string
}

/** Forget report (spec §3.2/§6). */
export interface ForgetReport {
  readonly id: MemoryId
  readonly suppressedRefs: number
  readonly note: string
}


