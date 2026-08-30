#!/usr/bin/env bash
# Regenerate the architecture diagram from its checked-in specification.
#
#   scripts/diagram.sh          # validate, then deliver if it passes
#   scripts/diagram.sh --watch  # re-run whenever the spec or src/ changes
#
# The diagram is NOT generated from the source tree automatically — no tool can
# infer which boxes matter. The specification is authored and reviewed like any
# other artifact; this script only keeps the rendered HTML in step with it, and
# refuses to ship a specification that does not pass showcase validation.
#
# "Live" therefore means: edit the spec (or run --watch while editing), and the
# HTML is rebuilt and re-checked on every change. It does not mean the drawing
# silently rewrites itself when someone renames a file — that would produce a
# picture nobody authored and nobody reviewed.
set -euo pipefail

SKILL="${ARCHIFY_HOME:-$HOME/.dsh/skills/archify}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/docs/diagrams/strataloom-architecture.json"
OUT="$ROOT/docs/diagrams/strataloom-architecture.html"

if [ ! -f "$SKILL/bin/archify.mjs" ]; then
  echo "archify skill not found at $SKILL" >&2
  echo "install: npx skills add tt-a1i/archify -g   (or set ARCHIFY_HOME)" >&2
  exit 127
fi

build() {
  # Validate first: deliver refuses a failing spec anyway, but a separate
  # validate keeps the diagnostics readable when it does fail.
  node "$SKILL/bin/archify.mjs" validate architecture "$SPEC" --quality showcase --json \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
        const d=JSON.parse(s);
        if(d.ok){console.log("validate: ok (9/9 showcase checks)");process.exit(0)}
        console.error("validate: FAILED");
        for(const x of d.diagnostics??[]) console.error("  "+x.code+" | "+x.message.split("\n")[0]);
        if(d.error) console.error("  "+d.error.split("\n")[0]);
        process.exit(1)})'
  node "$SKILL/bin/archify.mjs" deliver architecture "$SPEC" "$OUT" --quality showcase --json \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
        const d=JSON.parse(s);
        console.log("deliver: "+(d.ok?"ok":"FAILED")+"  "+d.artifact.bytes+" bytes  sha256="+d.artifact.sha256.slice(0,12));
        process.exit(d.ok?0:1)})'
}

if [ "${1:-}" != "--watch" ]; then
  build
  echo "open: $OUT"
  exit 0
fi

echo "watching $SPEC and packages/memory/src/ — Ctrl-C to stop"
build || true

# Prefer inotify when present; otherwise poll a checksum of the same files.
# Polling costs one stat sweep per second over a few dozen files, which beats
# making the reader install a package before the loop works at all.
stamp() {
  find "$SPEC" "$ROOT/packages/memory/src" -type f \( -name '*.ts' -o -name '*.json' \) \
    -printf '%T@ %p\n' 2>/dev/null | sort | cksum
}

if command -v inotifywait >/dev/null 2>&1; then
  while inotifywait -qq -e close_write,move,create -r "$SPEC" "$ROOT/packages/memory/src" 2>/dev/null; do
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
