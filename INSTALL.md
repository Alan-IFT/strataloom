# Installing StrataLoom into a dsh profile

Requires Node ≥ 22 (the plugin uses `node:sqlite`).

## Install

One command, no clone and no build:

```bash
dsh plugin --profile web add \
  https://github.com/Alan-IFT/strataloom/releases/latest/download/strataloom-dsh-memory-0.1.0.tgz
```

Then restart the harness.

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
npm run verify     # typecheck + 124 tests — do this before installing
npm pack           # -> strataloom-dsh-memory-0.1.0.tgz
dsh plugin --profile web add ./strataloom-dsh-memory-0.1.0.tgz
```

The plugin declares the harness packages as *peer* dependencies (the profile
supplies them at runtime) and mirrors them in `devDependencies` so a clean
checkout can build and test on its own.

## Publishing a release

`scripts/release.sh` verifies, packs, checks the tarball actually contains
`lib/index.js` (a tarball without it installs as an empty package — `main`
points there and `.gitignore` excludes it), then creates or updates the GitHub
release and prints the exact install command.

## 4. Verify

After booting, the model should have `memory_recall`, `memory_propose`, and
`memory_forget`. Save something, then check that a store appeared:

```bash
ls ~/.dsh/strataloom/repos/         # one directory per repository
ls ~/.dsh/strataloom/global.sqlite  # personal (cross-repo) memories
```

Stores are created on first write. A session whose working directory is not
inside a git work tree has no repository store — personal memories still work
there.

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
