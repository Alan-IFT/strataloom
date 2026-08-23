# @strataloom/dsh-memory

Repository-scoped memory for DeepSeek Harness: per-repo SQLite stores,
principal-gated tools, WAL-fresh context injection, and a leased
extract/reconcile pipeline.

Implements `plugin-architecture.md` v2.6. That document is the specification;
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
| `memory_forget` | principal only | Tombstones by id in either scope; `share: true` requests approval to commit it to `.repo_memory/` |
| context injection | principal only | Personal memories first, then repo working set; framed, ≤1400 tok |
| L0 capture | principal turns | Every turn recorded in our own store — provenance never depends on the platform log |
| auto-extract | principal turns | Reads our L0, extract → batch reconcile, leased jobs, one commit each |
| decay | daily job | Idle entries sleep, recently used ones revive, excerpts compact — never on the read path |
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
what gets searched; L0 is reached by id. Raw turns are pruned after 90 days,
except any a live memory still cites: a memory never outlives the words
behind it.

Memories live in `~/.dsh/strataloom/repos/<repo-key>/memory.sqlite`, keyed by
canonical git remote (or the work-tree realpath when there is no remote). A
session with no validated `cwd` inside a git work tree has no repo
affiliation: writes are refused and injection is empty — never a fallback to
`process.cwd()`.

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
- **D4** one authoritative write entry (`commitL1Mutation` /
  `commitClaimedJob`). Reads touch only the non-authoritative `usage` table.
- **D5** `forget` closes recall and injection at commit — no cache, so
  "immediately" is literal.
- **D6** the fencing CAS runs *before* any business write in the same
  transaction; a late worker performs zero writes.

Two structural rules make the above cheap rather than defensive:

1. **Every write transaction is `BEGIN IMMEDIATE`** — including the migration.
   Deferred transactions hit `SQLITE_BUSY_SNAPSHOT` on read-then-write
   upgrades, which `busy_timeout` does not cover.
2. **The migration reads `user_version` inside the lock**, not before it.
   Checking first is a TOCTOU that makes two concurrently starting processes
   replay the same migration.

## Development

```bash
npm run verify   # tsc + the full test suite
```

103 tests:

| File | Covers |
|---|---|
| `store.test.mjs` | migration atomicity, concurrent-migration TOCTOU regression, v1→v2 upgrade, CHECK/guard/FK enforcement, FTS trigger consistency, cross-process `BEGIN IMMEDIATE` contention |
| `service.test.mjs` | the synchronous propose→recall→forget loop, forged agents, subagent refusal, **ordinary-fork misfire regression**, no-repo refusal, FTS phrase escaping |
| `jobs.test.mjs` | idempotent enqueue, single-winner claims, lease expiry, fencing-before-writes, poison dead-letter, cleanup retention |
| `pipeline.test.mjs` | provenance mapping (all categories + unknown), source suppression and relearning, reconcile decisions per kind, malformed-reply retry exits |
| `pipeline-e2e.test.mjs` | the same pipeline through the **real `LlmRuntime`** with a registered adapter: pinned routing, single fallback, error/abort finishes, chunked reassembly |
| `inject.test.mjs` | discrete injection rules, audience, budget truncation, commit-visibility, cross-process WAL freshness |
| `e2e.test.mjs` | **real agent registry + real tool dispatch + real prompt assembly**, principal vs subagent, no-repo agent |
| `resilience.test.mjs` | bounded busy-retry, corrupt/foreign store isolation, fencing yield, mid-tick store failure, busy-agent deferral |
| `lifecycle.test.mjs` | activation, teardown ordering, HMR-shaped reload |
| `layers.test.mjs` | L0 round-trip/retention/drill-down, personal scope, **bidirectional D2**, dedup and `replaces`, metrics, decay and revival, derived rollup + **revision fencing**, projection/approval/secret scanning |
| `package.test.mjs` | the packed tarball installs as a dependency and loads **by package name** |

The last one matters most: a plugin that only works from its source tree is
not a deliverable, and no other test here would notice.

## Deliberately absent

**Vector indexing** and **continuous trust scores** were considered and
*rejected* in review, not postponed: the trust formula's thresholds had no
data behind them, and vector search would add a model dependency to a
question FTS already answers.

Also absent by design: a read cache (the read path is one SQL statement, so a
cache would be pure conceptual cost), and automatic extraction into the
personal scope (the explicit entry covers the need without guessing which
preferences are cross-repo).
