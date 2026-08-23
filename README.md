# StrataLoom

Repository-scoped memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a coding agent that remembers what it learned about your codebase, and how you
like to work, across sessions.

```
┌─ what the model sees ────────────────────────────────────────────┐
│  personal preferences  →  this repo's facts & procedures         │
│  (every repository)       (this checkout)                        │
└──────────────────────────────────────────────────────────────────┘
        ▲                             ▲
   global.sqlite              repos/<key>/memory.sqlite
        ▲                             ▲
        └──── memory_propose ─────────┘        memory_recall
                                               memory_forget
```

**Three tools.** `memory_recall` searches both scopes (and, with `sourceOf`,
returns the original conversation behind a memory). `memory_propose` saves —
`scope: 'personal'` for how you want to be worked with, otherwise this repo.
`memory_forget` removes one, or with `share: true` asks your permission to
commit it to `.repo_memory/` for the team.

**It also learns on its own.** Each turn is recorded, and a background
pipeline distils durable facts from it — never trusting the model to declare
where a memory came from.

## Install

See [INSTALL.md](INSTALL.md). Short version:

```bash
cd packages/memory && npm install && npm run verify && npm pack
dsh plugin --profile web add ./strataloom-dsh-memory-0.1.0.tgz
```

That single `add` is the whole installation: the package ships its own bundle
patch, so `dsh` registers it as a profile layer and it loads on the next
start. Nothing to hand-edit.

Requires Node ≥ 22 (`node:sqlite`). Everything lives in
`~/.dsh/strataloom/` — no external database, no network calls beyond the
model routes the harness already has.

## What is in this repository

| Path | What it is |
|---|---|
| [`docs/`](docs/README.md) | **Start here when picking the work up.** Document map, current status, design, and decision records. |
| [`docs/STATUS.md`](docs/STATUS.md) | Where the project stands and what is next. |
| [`packages/memory/`](packages/memory) | The plugin: `@strataloom/dsh-memory`. Start at its [README](packages/memory/README.md). |
| [`plugin-architecture.md`](plugin-architecture.md) | The specification. Where code and spec disagree, the spec normally wins — but the spec can be wrong too (v2.7 corrected six such places); fix the spec, don't bend the code back. |
| [`implementation-report.html`](implementation-report.html) | Visual comparison of design vs. implementation (snapshot, may lag). |

## Why the design looks like this

The spec went through several review rounds before any code existed, under
one rule: **less is more — prefer a design that removes a problem over
machinery that manages it.** A few consequences worth knowing before reading
the code, because each looks like an omission until you see the reason:

- **No cache.** The read path is one millisecond-class SQL statement, and
  SQLite in WAL mode already makes a committed write visible to every
  process. A cache would add an invalidation protocol to solve nothing.
- **No vector index.** Full-text search answers the question; embeddings
  would add a model dependency for a gain nobody has measured.
- **No trust scores.** Provenance is a small set of discrete categories with
  a fixed ordering. A weighted formula was drafted, then cut — its thresholds
  had no data behind them.
- **Layers only where a failure demands one.** Conversations are stored
  verbatim; memories are distilled from them; a summary rollup appears *only*
  while direct injection would overflow its budget, and disappears when it
  would not.

## Safety

Memory is an injection surface, so the boundaries are enforced in code and
verified by adversarial tests rather than asserted in prose:

- identity comes from platform session facts — a caller cannot claim to be
  the principal agent, and a subagent cannot write, forget, or share;
- a caller cannot assert a memory's visibility, provenance, or approval
  state; those are derived from which store the write lands in;
- injected memories are framed as reference data, and search input is escaped
  as literal text, so stored content cannot become instructions;
- the injected packet is delivered as a prompt *variable value*, which the
  platform substitutes verbatim and never rescans — so a memory containing
  `{{…}}` (a CI matrix, a template) stays data instead of becoming prompt
  syntax, and is preserved exactly rather than escaped;
- all three read exits turn stored content into text through one function,
  which renders one memory as one list item — so stored text cannot use its own
  newlines to step outside its entry and speak to the model directly, and the
  token budget prices the exact string the model receives;
- sharing to the repository needs human approval **and** passes a credential
  scan before anyone is asked;
- every authoritative write goes through one transaction entry, so a process
  killed mid-write leaves nothing half-applied.

## Development

```bash
cd packages/memory
npm install           # once
npm run verify        # typecheck + 114 tests
```

Tests run against the real platform where it matters: a real agent registry,
real tool dispatch, real prompt assembly, real LLM routing with a fixture
adapter, and a real second OS process for cross-process database behaviour.
One test packs the tarball, installs it as a dependency, and loads it by
package name — because a plugin that only works from its source tree is not
a deliverable.

## License

MIT
