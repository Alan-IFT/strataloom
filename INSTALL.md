# Installing StrataLoom into a dsh profile

Requires Node ≥ 22 (the plugin uses `node:sqlite`).

## Install

One command, no clone and no build:

```bash
dsh plugin --profile web add \
  https://github.com/Alan-IFT/strataloom/releases/latest/download/strataloom-dsh-memory.tgz
```

Then restart the harness.

## Update

`latest/download/` redirects to the newest release, and the asset name carries
no version, so the URL always means "current" — but pnpm resolves a URL
dependency once and pins that resolution in the lockfile. Running the install
command again is a no-op if the URL string has not changed: pnpm sees the same
specifier, trusts the lockfile's `integrity`, and never re-fetches. Measured,
not assumed — running `add` again on a real profile silently kept a previous
build in place while reporting success.

Remove, then add, so pnpm treats it as a new dependency instead of reusing a
pinned resolution:

```bash
dsh plugin --profile web remove @strataloom/dsh-memory
dsh plugin --profile web add \
  https://github.com/Alan-IFT/strataloom/releases/latest/download/strataloom-dsh-memory.tgz
```

Restart, then confirm from the log line the plugin prints at startup:

```
strataloom 0.3.0 ready (data: /home/you/.dsh/strataloom)
```

**Your memories are not touched.** They live in `~/.dsh/strataloom/`, outside
the plugin directory, and an update only replaces code. If the new build needs
a newer database layout it migrates each store on first open, inside one
transaction — a store is never left half-migrated, and a store newer than the
running build is refused rather than downgraded.

There is deliberately no automatic update check: it would be this plugin's
first outbound request, and would need an offline story, a timeout, a
frequency nobody can justify, and a reason to send install counts anywhere.
Watch the repository's releases instead.

That single `add` is the whole installation. `dsh plugin` forwards its
arguments to pnpm inside the profile, and reconciles the profile manifest
afterwards: a dependency declaring `dsh.bundle` is appended to
`dsh.profile.bundles` automatically. This package declares one and ships a
`cordis.patch.yml` that inserts itself into the layer stack, so installing and
loading are the same step. Nothing to hand-edit.

> **Why a release asset and not the git URL?** The published tarball carries
> `lib/` already built. Installing from git would need pnpm to run our build
> script, and pnpm blocks build scripts on git dependencies until the user adds
> an `allowBuilds` entry — a security decision, and a hand-edited file, pushed
> onto everyone installing. Shipping built output removes the build step rather
> than asking permission for it.

## Install from source instead

For a checkout you are modifying:

```bash
cd packages/memory
npm install        # platform packages come from npm; nothing else is needed
npm run verify     # typecheck + 133 tests — do this before installing
npm pack           # -> strataloom-dsh-memory-<version>.tgz
dsh plugin --profile web add ./strataloom-dsh-memory-<version>.tgz
```

The plugin declares the harness packages as *peer* dependencies (the profile
supplies them at runtime) and mirrors them in `devDependencies` so a clean
checkout can build and test on its own.

## Publishing a release

```bash
bash scripts/release.sh
```

It verifies, packs, checks the tarball actually contains `lib/index.js` (a
tarball without it installs as an empty package — `main` points there and
`.gitignore` excludes it), then creates or updates the GitHub release and
prints the install command.

### Over SSH, or on a headless host

The device flow needs no browser *on this machine* — but `gh` will still try
to open one at the "Press Enter" prompt, and if `DISPLAY` is set (X11
forwarding, common over SSH) that launches a real browser through the tunnel:
slow, and buried in unrelated GPU/TensorFlow warnings from Chrome. Point
`BROWSER` at a no-op so `gh` prints the code and waits instead:

```bash
BROWSER=true gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key
```

It prints a one-time code and a URL, then waits. Open the URL on whatever
device you like, enter the code, and the command completes on its own.

If you would rather not store a token, pass one for a single run:

```bash
GH_TOKEN=<token with the repo scope> bash scripts/release.sh
```

The script checks authentication *before* building or tagging, so an expired
token costs you an error message and nothing else — no half-published tag to
clean up.

## Verify

After booting, the model should have `memory_recall`, `memory_propose`, and
`memory_forget`. Save something, then check that a store appeared:

```bash
ls ~/.dsh/strataloom/repos/         # one directory per repository
ls ~/.dsh/strataloom/global.sqlite  # personal (cross-repo) memories
```

Stores are created on first write. A session whose working directory is not
inside a git work tree has no repository store — personal memories still work
there.

## Looking at what it has learned

In a session, ask it directly:

```
/memory                  what is remembered here, both scopes
/memory forget <id>      remove one
```

The plugin learns as you work, so this is how you see what it picked up
without having to guess a search term. Listing is a read, open to any session;
forgetting goes through the same principal check as the tool, because the
command runs inside the agent context rather than around it.

From a shell, for trends and the evidence behind phase 4:

```bash
node scripts/inspect.mjs            # per-store summary and the weekly recall trend
node scripts/inspect.mjs --misses   # the conversation around each recall miss
node scripts/inspect.mjs --days 30  # narrower window (default 90)
```

Read-only, and it needs no `sqlite3` binary. Everything shown is a query over
data the plugin already stores: the periodic metrics line is a snapshot that
log rotation eventually discards, but L0 rows carry timestamps, so the *trend*
is recoverable retroactively — which is why there is no time-series table.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `rootDir` | `~/.dsh/strataloom` | Where stores live. Useful for testing, or to keep memory on another volume. |

To set it, add a row to the profile's own `cordis.patch.yml` (that layer is
applied after every bundle layer, so it overrides the defaults this package
inserted):

```yaml
- id: strataloom-memory
  config:
    rootDir: /data/strataloom
```

Nothing else is configurable by design: budgets, retention windows, and decay
thresholds are calibration parameters kept in one file (`src/constants.ts`),
not deployment knobs.

## Optional services

The plugin runs without these, but they enable more:

| Service | Without it |
|---|---|
| `llm` | No automatic extraction; the three tools and injection still work. |
| `agentDefaultModel` | No fallback when a pinned model route fails; no summary rollups. |
| `approval` | `memory_forget … share: true` refuses — sharing always needs a human. |

## Uninstall

```bash
dsh plugin --profile web remove @strataloom/dsh-memory
```

Stored memories remain in `~/.dsh/strataloom/`; delete that directory to
remove them. A `.repo_memory/` directory committed to a repository is
ordinary tracked content, yours to keep or delete.
