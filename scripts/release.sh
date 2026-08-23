#!/usr/bin/env bash
# Publish a release whose asset is directly installable:
#
#   dsh plugin --profile <name> add <asset-url>
#
# The asset is a packed tarball with `lib/` already built, which is what makes
# that one command work. Installing from the git URL instead would need pnpm to
# run our `prepare` script, and pnpm blocks build scripts for git dependencies
# unless the USER adds an `allowBuilds` entry — pushing a security decision, and
# a hand-edited file, onto everyone who installs. Shipping built output removes
# the build step rather than asking permission for it.
set -euo pipefail

cd "$(dirname "$0")/../packages/memory"

version=$(node -p "require('./package.json').version")
tag="v${version}"

echo "==> verifying (typecheck + tests)"
npm run verify

echo "==> packing"
rm -f ./*.tgz
tarball=$(npm pack --silent)

# A tarball missing `lib/` installs as an empty package: `main` points there and
# `.gitignore` excludes it, so this is the one failure that would reach users
# silently. Fail here instead.
if ! tar tzf "$tarball" | grep -q '^package/lib/index\.js$'; then
  echo "error: $tarball has no lib/index.js — build output missing" >&2
  exit 1
fi

echo "==> releasing $tag"
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$tarball" --clobber
else
  git tag -a "$tag" -m "$tag" 2>/dev/null || true
  git push origin "$tag"
  gh release create "$tag" "$tarball" \
    --title "$tag" \
    --notes "Install:

\`\`\`bash
dsh plugin --profile <name> add https://github.com/Alan-IFT/strataloom/releases/download/$tag/$tarball
\`\`\`

Requires Node >= 22 (\`node:sqlite\`). Restart the harness afterwards."
fi

echo
echo "installable with:"
echo "  dsh plugin --profile <name> add \\"
echo "    https://github.com/Alan-IFT/strataloom/releases/download/$tag/$tarball"
