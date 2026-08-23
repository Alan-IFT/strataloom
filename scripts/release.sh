#!/usr/bin/env bash
# Publish a release whose asset is directly installable AND updatable:
#
#   dsh plugin --profile <name> add  https://.../releases/latest/download/strataloom-dsh-memory.tgz
#   dsh plugin --profile <name> add  <the same URL>      # this is also the update
#
# Two decisions make that one URL work for both:
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

echo "==> verifying (typecheck + tests)"
npm run verify

echo "==> packing"
rm -f ./*.tgz
packed=$(npm pack --silent)

# A tarball missing `lib/` installs as an empty package: `main` points there and
# `.gitignore` excludes it, so this is the one failure that would reach users
# silently. Fail here instead.
if ! tar tzf "$packed" | grep -q '^package/lib/index\.js$'; then
  echo "error: $packed has no lib/index.js — build output missing" >&2
  exit 1
fi

# The published name must not be the versioned one npm produced.
mv -f "$packed" "$asset"

url="https://github.com/${repo}/releases/latest/download/${asset}"

echo "==> releasing $tag"
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$asset" --clobber
else
  git tag -a "$tag" -m "$tag" 2>/dev/null || true
  git push origin "$tag"
  gh release create "$tag" "$asset" \
    --title "$tag" \
    --notes "Install or update — the same command either way:

\`\`\`bash
dsh plugin --profile <name> add $url
\`\`\`

Then restart the harness. Stored memories in \`~/.dsh/strataloom/\` are kept
across updates; the schema migrates itself on first open.

Requires Node >= 22 (\`node:sqlite\`)."
fi

rm -f "$asset"

echo
echo "install and update both use:"
echo "  dsh plugin --profile <name> add $url"
