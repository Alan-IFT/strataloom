#!/usr/bin/env bash
# Publish a release whose asset is directly installable, and updatable via
# INSTALL.md's remove-then-add (see that file: pnpm pins a URL dependency's
# resolution, integrity included, so a plain `add` over changed bytes fails
# loudly with ERR_PNPM_TARBALL_INTEGRITY rather than silently reusing).
#
#   dsh plugin --profile <name> add https://.../releases/latest/download/strataloom-dsh-memory.tgz
#
# Two decisions make that URL keep working release after release:
#
# 1. The asset is a packed tarball with `lib/` already built. Installing from
#    the git URL instead would need pnpm to run our `prepare` script, and pnpm
#    blocks build scripts on git dependencies unless the USER adds an
#    `allowBuilds` entry — pushing a security decision, and a hand-edited file,
#    onto everyone who installs.
# 2. The asset name carries NO version. GitHub's `/releases/latest/download/<name>`
#    redirects to the newest release only when the filename is stable across
#    releases, so a versioned name would make that URL 404 the moment a new
#    version shipped — turning "update" into "edit the URL". The version still
#    lives in the tag, the release title, and the package itself.
set -euo pipefail

cd "$(dirname "$0")/../packages/memory"

version=$(node -p "require('./package.json').version")
tag="v${version}"
repo="Alan-IFT/strataloom"
# Stable name: the same URL means "current" forever (see decision 2 above).
asset="strataloom-dsh-memory.tgz"

# Refuse to re-publish a version that already has a release.
#
# The install URL is deliberately version-free, which makes it a promise about
# BYTES: any lockfile that resolved it stored the `integrity` of what it saw.
# Replacing an already-published version's asset breaks that promise for every
# profile holding it — their next install fails with
# ERR_PNPM_TARBALL_INTEGRITY, because content changing under a fixed URL is
# indistinguishable from a supply-chain swap.
#
# So this guard protects other people's working installs, not just this
# release. Fail here instead.
#
# (This comment previously said a re-publish was a SILENT no-op that left
# profiles on the old build while reporting success. That was wrong — pnpm
# exits non-zero and refuses to install. The guard stands; its reason did not.)
if gh release view "$tag" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: $tag is already released.

The install URL carries no version, so pnpm decides what to re-download from
the package version alone. Re-publishing $version would leave existing
installs on the old build while reporting success.

Bump "version" in packages/memory/package.json, then run this again.
EOF
  exit 1
fi

# Check authentication BEFORE doing anything with side effects. Without this,
# an expired token makes `gh release view` fail, which reads as "no release
# yet", which pushes the tag — and only then does `gh release create` fail,
# leaving a pushed tag with no release behind it.
if ! gh auth status >/dev/null 2>&1; then
  cat >&2 <<'AUTH'
error: not authenticated to GitHub.

Over SSH or on a headless host, use the device flow. `BROWSER=true` stops gh
from launching a browser through X11 forwarding; it prints a code and waits
while you authorize from any other device:

  BROWSER=true gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key

Or, if you already have a token (needs the `repo` scope):

  gh auth login --with-token < /path/to/token
  # or, for one command only:  GH_TOKEN=... bash scripts/release.sh

Nothing has been built, tagged or pushed.
AUTH
  exit 1
fi

echo "==> verifying (typecheck + tests)"
npm run verify

echo "==> packing"
rm -f ./*.tgz
# Not `npm pack --silent`: that silences the filename it prints on stdout too,
# so the name comes back empty and every later step operates on "". Pack
# normally and find the artefact on disk, which is also the honest question —
# what was actually produced, not what npm said it produced.
npm pack >/dev/null
# Glob rather than `ls | head`: `head` closes the pipe early, which SIGPIPEs
# `ls`, which `pipefail` reports as failure — the same trap as the check below.
# `rm -f ./*.tgz` above means at most one match.
packed=$(printf '%s' ./*.tgz)
[[ -f $packed ]] || packed=''
if [[ -z $packed ]]; then
  echo "error: npm pack produced no tarball (its output is above)" >&2
  exit 1
fi

# A tarball missing `lib/` installs as an empty package: `main` points there and
# `.gitignore` excludes it, so this is the one failure that would reach users
# silently. Fail here instead.
#
# Listed into a variable rather than piped to `grep -q`: `-q` exits on the
# first match, `tar` then dies of SIGPIPE, and `pipefail` turns that into a
# failed pipeline — so a SUCCESSFUL match reported the archive as broken.
# Reading the whole listing first keeps the check's answer about the tarball
# rather than about who closed the pipe.
contents=$(tar tzf "$packed")
if ! grep -qx 'package/lib/index\.js' <<<"$contents"; then
  echo "error: $packed has no lib/index.js — build output missing" >&2
  exit 1
fi

# The published name must not be the versioned one npm produced.
mv -f "$packed" "$asset"

url="https://github.com/${repo}/releases/latest/download/${asset}"

echo "==> releasing $tag"
# Always a fresh release: re-publishing an existing version is refused above,
# because it would be a no-op for everyone already installed.
#
# `gh release create --target` tags on the server, so there is no local tag to
# push and nothing to strand if the call fails. It also keeps the tag and the
# release atomic from the user's point of view: either both exist or neither
# does.
gh release create "$tag" "$asset" \
  --target "$(git rev-parse HEAD)" \
  --title "$tag" \
  --notes "Install:

\`\`\`bash
dsh plugin --profile <name> add $url
\`\`\`

Update (plain \`add\` again is a no-op — pnpm pins the resolved URL):

\`\`\`bash
dsh plugin --profile <name> remove @strataloom/dsh-memory
dsh plugin --profile <name> add $url
\`\`\`

Then restart the harness. Stored memories in \`~/.dsh/strataloom/\` are kept
across updates; the schema migrates itself on first open.

Requires Node >= 22 (\`node:sqlite\`)."

rm -f "$asset"

echo
echo "install:"
echo "  dsh plugin --profile <name> add $url"
echo "update (remove first — plain add again is a no-op):"
echo "  dsh plugin --profile <name> remove @strataloom/dsh-memory"
echo "  dsh plugin --profile <name> add $url"
