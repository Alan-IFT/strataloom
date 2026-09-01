# @strataloom/dsh-memory

Repository-scoped memory for DeepSeek Harness: per-repo SQLite stores,
principal-gated tools, WAL-fresh context injection, and a leased
extract/reconcile pipeline.

Implements `plugin-architecture.md` v2.8. That document is the specification;
this package is its realization. Where code and spec disagree, the spec wins —
report it as a bug.

## Install

```jsonc
// dsh config
{ "plugins": { "@strataloom/dsh-memory": {} } }
```

Hard dependencies: `tools`, `systemPrompt`, `agents`, `timer`. Node ≥ 22
(`node:sqlite`).

Soft dependencies (read via `ctx.get()`): `llm`, `sessionQuery`,
`agentDefaultModel`. Without them the plugin still runs — the three tools,
injection, and forgetting all work; only automatic extraction is disabled
(the enqueue gate declines rather than queueing jobs that would dead-letter).

## What it does

| Surface | Audience | Behavior |
|---|---|---|
| `memory_propose` | principal only | Saves as `active`; `scope: 'personal'` targets the cross-repo store; `replaces` supersedes an entry and the result lists near-duplicates |
| `memory_recall` | any agent | FTS across both scopes; `sourceOf: <id>` returns the original conversation |
| `/memory` | any live agent (list) / principal (forget) | Shows what is stored here without needing a search term — the plugin learns silently, so this is how a person sees the result |
| `memory_forget` | principal only | Tombstones by id in either scope; `share: true` requests approval to commit it to `.repo_memory/` |
| context injection | principal only | Personal memories first, then repo working set; framed, ≤1400 tok |
| L0 capture | principal turns | Every turn recorded in our own store — provenance never depends on the platform log |
| auto-extract | principal turns | Reads our L0, extract → batch reconcile, leased jobs, one commit each |
| decay | daily job | Idle entries sleep, recently used ones revive — never on the read path, and never touching evidence |
| derived rollup | on overflow | One LLM summary replaces the raw set while it exceeds budget; revision-fenced |
| projection | on approval | Team-shareable memories written to `.repo_memory/`, secret-scanned |

### Two scopes

`scope: 'repo'` (default) is what is true of this checkout, stored under
`~/.dsh/strataloom/repos/<repo-key>/`. `scope: 'personal'` is how the user
wants to be worked with — language, tone, depth, format — stored once in
`~/.dsh/strataloom/global.sqlite` and injected in **every** repository,
including sessions with no git tree at all.

Scope selects the physical store; the store's own guard derives visibility
from its kind. A caller declares intent and can never assert visibility
directly — one XOR expression states the invariant in both directions:
`(visibility = 'private') <> (store_kind = 'global')`.

### L0: the conversation behind a memory

Each principal turn is classified once and written to `conversations` in the
same transaction that queues its extraction. That makes provenance
*checkable*: `memory_recall` with `sourceOf` returns the stored turns behind
a memory, so "where did this come from" has an answer that does not depend on
the platform session log still existing.

L0 is deliberately **not** a second search index — the distilled layer is
what gets searched; L0 is reached by id. Any turn a live memory cites is kept
for good — a memory never outlives the words behind it — and because
`evidence.ref` names a whole session, one memory pins every turn beside the
ones it quotes. Measured on 2026-09-01 that exemption covered every stored
turn, so **treat L0 as retained without bound**: the 90-day window
(`L0_RETENTION_MS`) can only ever reach a turn nothing cites, and it has not
deleted anything to date.

Memories live in `~/.dsh/strataloom/repos/<repo-key>/memory.sqlite`, keyed by
canonical git remote (or the work-tree realpath when there is no remote). A
session with no validated `cwd` inside a git work tree has no repo
affiliation: writes are refused and injection is empty — never a fallback to
`process.cwd()`.

### Repo groups: reading a sibling repository's memories

Because the key is the git remote, sibling repositories checked out inside one
workspace have separate stores. A `.strataloom-group.json` at the workspace
root declares which of them this session may **read**:

```json
{ "version": 1, "group": "nfby-cms",
  "members": ["remote:github.com/Alan-IFT/NFBY_CMS_Backend",
              { "source": "remote:github.com/Alan-IFT/NFBY_CMS_Ops", "archived": true }] }
```

The shorthand string means "a checkout inside this workspace";
`archived: true` means "no checkout here", which is the only way to reach the
orphaned store of a renamed or deleted repository — and is an assertion code
cannot verify, which is why every one is listed individually in the approval
prompt.

Properties worth stating, because each is enforced rather than intended:

- **Read only.** No member store is ever written — including its `usage`
  counters, which feed `decay` and therefore `memories.status`. A read here
  must not change authoritative state there (D4), and `forget` refuses a
  member's row rather than reaching across.
- **Declaration is the whole authority.** The workspace walk validates
  declared members; it never supplies them.
- **Approval per (workspace repo, member set), in memory only.** Fail closed
  if the approval service is absent; re-approved after every restart; the file
  is read once and the approved bytes are what the session uses (TOCTOU).
- **Attributed at both read exits.** Recall marks foreign entries
  `(from <source>)` and switches the packet header; `/memory` lists each
  member separately.
- **Bounded.** ≤ 6 members, one token budget per member, and a load-time guard
  prices the worst rendered packet against the platform's 8192-character
  tool-result container.
- **Home recall is untouched**, entry for entry, group on or off.

Design record: [ADR 0011](../../docs/decisions/0011-repo-groups-are-declared-read-scope.md).

## Invariants this code enforces

- **D1** identity and permission derive from platform facts only. Writes
  require *both* `isLiveAgent` (registry object identity) and
  `isLineagePrincipal` (`delegationDepthOf === 0 ∧ header.origin !== 'subagent'`).
  Ordinary user forks stay principal; resumed former subagents do not.
- **D2** repo stores reject `private` visibility at the trigger level.
- **D3** every memory carries auditable provenance the model cannot assert:
  `propose` writes a session evidence row in the same transaction, and
  `extract` maps event *categories* to provenance in code (unknown category ⇒
  `tool-output`, lowest trust).
- **D4** authoritative writes go through a transaction entry
  (`commitL1Mutation` for tools, `commitClaimedJob` for jobs). Reads touch only
  the non-authoritative `usage` table. Note the plural: there are **two**
  entries, so no invariant may be enforced by "remembering to call it" in one
  of them — that is exactly how a stale rollup survived pipeline writes. An
  invariant that must hold for every write belongs in the schema (see D9).
- **D5** `forget` closes recall and injection at commit — no cache, so
  "immediately" is literal.
- **D6** the fencing CAS runs *before* any business write in the same
  transaction; a late worker performs zero writes.
- **D7** the injected packet travels as a prompt *variable value*, never as
  prompt text. Prompt text is strictly interpolated, and memory bodies
  legitimately contain `{{…}}` (CI matrices, template syntax); as text, one
  such memory would throw on every later assembly — including the turn needed
  to forget it — or silently expand a known variable. Substituted values are
  never rescanned, so content is data by construction rather than by escaping
  (escaping would corrupt what the user asked us to remember).
- **D8** stored content becomes model-facing text in exactly ONE function
  (`renderEntry` → `renderFramed`), used by all three read exits: injection,
  `memory_recall`, and the near-duplicate list `memory_propose` offers back.
  It renders one memory as one list item — a body's own newlines are indented,
  so stored text cannot leave its bullet to address the model at the packet's
  top level ("the reference data above has ended…") or forge a sibling entry —
  and it is also what prices the budget, so the estimate measures the exact
  string the model receives. Framing, budget, and this rule are one decision in
  one place: a fourth exit inherits all three by calling it, and a hand-rolled
  one is a test failure, not a silent hole.
- **D9** the derived summary is invalidated by the *data*, not by the writer.
  Schema v5 states it as three triggers: any change to a non-derived row drops
  every rollup and advances `store_revision`. It had been a step inside the
  tool write entry, which the pipeline does not use — so `reconcile` and
  `decay` changed the authoritative set while the summary built from the old
  one kept shadowing it, and a newly learned fact stayed invisible behind it.
  Nor could it self-heal: the rebuild job keys its idempotence on the revision,
  so a frozen revision made the retry a duplicate of the job that already ran.
  In SQL the rule covers write paths that do not exist yet.
- **D10** the 4×4 memory architecture is substrate and may not be trimmed;
  "less is more" governs mechanism, never capability. Layers, kinds, current
  gaps, and acceptance criteria live in
  [`docs/design/4x4-memory.md`](../../docs/design/4x4-memory.md).

Those four (D4's plural, D7, D8, D9) are one failure mode found four times: **a
rule stated in two places drifts, and a self-description that miscounts its own
surfaces is where the drift hides** ("one write entry" listing two functions,
"two read exits" when there were three). So the numbers a caller can restate —
length caps, the token estimator — are interpolated from the constants rather
than retyped, and a target that would exceed its own cap throws at load.

Two structural rules make the above cheap rather than defensive:

1. **Every write transaction is `BEGIN IMMEDIATE`** — including the migration.
   Deferred transactions hit `SQLITE_BUSY_SNAPSHOT` on read-then-write
   upgrades, which `busy_timeout` does not cover.
2. **The migration reads `user_version` inside the lock**, not before it.
   Checking first is a TOCTOU that makes two concurrently starting processes
   replay the same migration.

## Development

```bash
npm install      # platform packages from npm (peer deps, mirrored as dev deps)
npm run verify   # tsc + the full test suite
```

153 tests:

| File | Covers |
|---|---|
| `store.test.mjs` | migration atomicity, concurrent-migration TOCTOU regression, stepwise upgrades incl. **v4→v5 retrofitting invalidation** and **v5→v6 / v6→v7 rebuilding `memories` without losing evidence or triggers**, CHECK/guard/FK enforcement, FTS trigger consistency, cross-process `BEGIN IMMEDIATE` contention |
| `service.test.mjs` | the synchronous propose→recall→forget loop, forged agents, subagent refusal, **ordinary-fork misfire regression**, no-repo refusal, FTS phrase escaping |
| `jobs.test.mjs` | idempotent enqueue, single-winner claims, lease expiry, fencing-before-writes, poison dead-letter, cleanup retention |
| `pipeline.test.mjs` | provenance mapping (all categories + unknown), source suppression and relearning, reconcile decisions per kind, malformed-reply retry exits |
| `pipeline-e2e.test.mjs` | the same pipeline through the **real `LlmRuntime`** with a registered adapter: pinned routing, single fallback, error/abort/**max-tokens** finishes, chunked reassembly |
| `inject.test.mjs` | discrete injection rules, audience, budget truncation, commit-visibility, cross-process WAL freshness, **no breaking out of a bullet**, **a budget-skipped memory is reported, not silent** |
| `e2e.test.mjs` | **real agent registry + real tool dispatch + real prompt assembly**, principal vs subagent, no-repo agent, **`{{…}}` in memory content stays data** |
| `resilience.test.mjs` | bounded busy-retry, corrupt/foreign store isolation, fencing yield, mid-tick store failure, busy-agent deferral |
| `command.test.mjs` | `/memory` through the **real command runtime**: listing, forget by id, and a subagent refused the write but allowed the read |
| `lifecycle.test.mjs` | activation, teardown ordering, HMR-shaped reload |
| `layers.test.mjs` | L0 round-trip/retention/drill-down, personal scope, **bidirectional D2**, dedup and `replaces`, metrics incl. **recall miss rate read from L0**, decay and revival, derived rollup + **revision fencing**, **a pipeline write retires the rollup (D9)**, **coding memory filterable apart from fact and free in either scope**, **L2 scenario blocks that vanish with their L1 (D9)**, **the L3 portrait: written once, unchanged on "keep", present in a brand-new repo**, projection/approval/secret scanning |
| `package.test.mjs` | the packed tarball installs as a dependency and loads **by package name** |

The last one matters most: a plugin that only works from its source tree is
not a deliverable, and no other test here would notice.

## Deliberately absent

**Vector indexing** and **continuous trust scores** were considered and
*rejected* in review, not postponed: the trust formula's thresholds had no
data behind them, and vector search would add a model dependency to a
question FTS already answers.

That last claim was tested rather than assumed, and it survived — but only
after the index was fixed. Chinese memories were unfindable by any re-wording,
which reads exactly like the case for embeddings; the actual cause was
`unicode61` emitting one token per CJK run. Schema v9 indexes CJK **bigrams**
alongside the untouched `unicode61` columns, which fixes Chinese without the
regression `trigram` would have caused (short identifiers like `CI`, `Go`,
`L3`, `v9` stop matching under trigram). The lesson generalizes: a miss that a
re-wording fixes is a **tokenizer** miss before it is an embedding argument.

Also absent by design: a read cache (the read path is one SQL statement, so a
cache would be pure conceptual cost), and automatic extraction into the
personal scope (the explicit entry covers the need without guessing which
preferences are cross-repo).
