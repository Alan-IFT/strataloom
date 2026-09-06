#!/usr/bin/env bash
# Regenerate the architecture diagram set from its checked-in specifications.
#
#   scripts/diagram.sh          # validate, then deliver every diagram that passes
#   scripts/diagram.sh --watch  # re-run whenever a spec or src/ changes
#
# The diagrams are NOT generated from the source tree automatically — no tool can
# infer which boxes matter. The specifications are authored and reviewed like any
# other artifact; this script only keeps the rendered HTML in step with them, and
# refuses to ship a specification that does not pass showcase validation.
#
# "Live" therefore means: edit a spec (or run --watch while editing), and the
# HTML is rebuilt and re-checked on every change. It does not mean the drawing
# silently rewrites itself when someone renames a file — that would produce a
# picture nobody authored and nobody reviewed.
#
# The architecture diagram additionally declares `meta.repository` plus per-node
# `sources`, so it is rendered with --repo-root: archify then VERIFIES every
# cited path against this checkout and fails delivery when a citation has gone
# stale. That check is the reason a renamed module is caught here rather than by
# a reader who trusts a box that no longer exists. The other four modes do not
# accept repository evidence, so they are delivered without it.
set -euo pipefail

SKILL="${ARCHIFY_HOME:-$HOME/.dsh/skills/archify}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/docs/diagrams"

# type:basename — one row per diagram. The architecture row is first because it
# is the entry point every other diagram expands on.
DIAGRAMS=(
  "architecture:strataloom-architecture"
  "workflow:strataloom-pipeline-workflow"
  "sequence:strataloom-turn-sequence"
  "dataflow:strataloom-dataflow"
  "lifecycle:strataloom-job-lifecycle"
)

if [ ! -f "$SKILL/bin/archify.mjs" ]; then
  echo "archify skill not found at $SKILL" >&2
  echo "install: npx skills add tt-a1i/archify -g   (or set ARCHIFY_HOME)" >&2
  exit 127
fi

report() {
  # Shared JSON reader: prints one line per stage and exits non-zero on failure,
  # so a broken spec cannot be mistaken for a slow one.
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const d=JSON.parse(s), stage=process.argv[1], name=process.argv[2];
      if(d.ok){
        console.log(stage==="validate"
          ? `  validate: ok (${d.checksPassed??9}/${d.checkCount??9} showcase checks)`
          : `  deliver:  ok  ${d.artifact.bytes} bytes  sha256=${d.artifact.sha256.slice(0,12)}`);
        process.exit(0)}
      console.error(`  ${stage}: FAILED (${name})`);
      for(const x of d.diagnostics??[]) console.error("    "+x.code+" | "+x.message.split("\n")[0]);
      if(d.error) console.error("    "+d.error.split("\n")[0]);
      process.exit(1)})' "$1" "$2"
}

build_one() {
  local type="$1" name="$2"
  local spec="$DIR/$name.json" out="$DIR/$name.html"
  local -a evidence=()
  # Only architecture accepts --repo-root; the other modes reject it outright.
  [ "$type" = "architecture" ] && evidence=(--repo-root "$ROOT")

  echo "$name ($type)"
  # Validate first: deliver refuses a failing spec anyway, but a separate
  # validate keeps the diagnostics readable when it does fail.
  node "$SKILL/bin/archify.mjs" validate "$type" "$spec" --quality showcase \
    "${evidence[@]}" --json | report validate "$name"
  node "$SKILL/bin/archify.mjs" deliver "$type" "$spec" "$out" --quality showcase \
    "${evidence[@]}" --json | report deliver "$name"
}

build() {
  local failed=0
  for row in "${DIAGRAMS[@]}"; do
    # Keep going after a failure so one broken spec does not hide the others;
    # the exit code still reports that something did not ship.
    build_one "${row%%:*}" "${row#*:}" || failed=1
  done
  return "$failed"
}

if [ "${1:-}" != "--watch" ]; then
  build
  echo
  echo "open: $DIR/${DIAGRAMS[0]#*:}.html"
  exit 0
fi

echo "watching $DIR/*.json and packages/memory/src/ — Ctrl-C to stop"
build || true

# Prefer inotify when present; otherwise poll a checksum of the same files.
# Polling costs one stat sweep per second over a few dozen files, which beats
# making the reader install a package before the loop works at all.
stamp() {
  find "$DIR" "$ROOT/packages/memory/src" -type f \( -name '*.ts' -o -name '*.json' \) \
    -printf '%T@ %p\n' 2>/dev/null | sort | cksum
}

if command -v inotifywait >/dev/null 2>&1; then
  while inotifywait -qq -e close_write,move,create -r "$DIR" "$ROOT/packages/memory/src" 2>/dev/null; do
    echo "--- $(date +%H:%M:%S) change detected"
    build || true
  done
else
  last="$(stamp)"
  while sleep 1; do
    now="$(stamp)"
    [ "$now" = "$last" ] && continue
    last="$now"
    echo "--- $(date +%H:%M:%S) change detected"
    build || true
  done
fi
