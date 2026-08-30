#!/usr/bin/env node
/**
 * Read the evidence that decides the deferred work (`docs/design/4x4-memory.md`
 * §5 phase 4, ADR 0005).
 *
 *   node scripts/inspect.mjs            # every store
 *   node scripts/inspect.mjs --days 30  # narrower window
 *   node scripts/inspect.mjs --misses   # the transcripts behind the misses
 *
 * Everything here is a query over data the plugin already keeps. Nothing is
 * accumulated for reporting: the periodic metrics line is a snapshot that log
 * rotation eventually discards, but L0 rows carry their own timestamps, so the
 * TREND is recoverable retroactively with a GROUP BY. That is the whole reason
 * no time-series table exists — the honest question is what happened, and the
 * data answering it was already being stored for provenance.
 *
 * That line held once and was crossed: a failed-job classifier read
 * `payload.expectedRevision` to decide whether a job would ever run again, which
 * is an inference about the pipeline's rules, not a query over its data. It is
 * gone; this file reports failed rows and lets the plugin's own lifecycle decide
 * which of them still mean anything.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const RECALL_NO_MATCH = 'No stored memories matched.'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const has = (name) => process.argv.includes(`--${name}`)

const root = arg('root', join(homedir(), '.dsh', 'strataloom'))
const days = Number(arg('days', '90'))
const since = Date.now() - days * 86_400_000

const stores = []
const globalDb = join(root, 'global.sqlite')
if (existsSync(globalDb)) stores.push(['global', globalDb])
const reposDir = join(root, 'repos')
if (existsSync(reposDir)) {
  for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(reposDir, entry.name, 'memory.sqlite')
    if (existsSync(file)) stores.push([entry.name.slice(0, 12), file])
  }
}

if (stores.length === 0) {
  console.log(`no stores under ${root} yet — nothing has been remembered.`)
  process.exit(0)
}

const pct = (n, d) => (d === 0 ? '  —  ' : `${((n / d) * 100).toFixed(0)}%`.padStart(5))

/**
 * How long ago a timestamp was, in the unit that carries information. Whole
 * days floor to `0d ago` for anything under 24h, which reads as "just now" for
 * a job that in fact died most of a day back — the exact span where an operator
 * is deciding whether a failure is current. Below a day, report hours.
 */
const ago = (at) => {
  if (at === null || at === undefined) return 'at an unrecorded time'
  const ms = Date.now() - at
  return ms < 86_400_000
    ? `${Math.floor(ms / 3_600_000)}h ago`
    : `${Math.floor(ms / 86_400_000)}d ago`
}

for (const [label, file] of stores) {
  const db = new DatabaseSync(file, { readOnly: true })
  const one = (sql, ...p) => db.prepare(sql).get(...p) ?? {}

  const memories = one(`
    SELECT count(*) AS total,
           sum(CASE WHEN status='active' AND derived=0 THEN 1 ELSE 0 END) AS active,
           sum(CASE WHEN derived!=0 THEN 1 ELSE 0 END) AS derivedRows
    FROM memories`)
  const recall = one(
    `SELECT count(*) AS calls,
            sum(CASE WHEN text LIKE ?||'%' THEN 1 ELSE 0 END) AS misses
     FROM conversations WHERE label='tool:memory_recall' AND created_at >= ?`,
    RECALL_NO_MATCH, since,
  )
  // Tool results that have no request beside them. Until 0.3.6 the capture
  // dropped every `tool/call`, so this was 100% by construction and L0 recorded
  // what tools replied without recording what the agent did.
  //
  // It is here because it answers a question no version string can: a release
  // that is installed but not yet RUNNING leaves this at 100% while every
  // version check reports the new build. Reading it over a window ("since")
  // rather than over all history is what makes it a liveness signal instead of
  // a historical fact — old rows stay orphaned forever and would mask the
  // change. A store with no recent turns simply reports no calls.
  const pairing = one(
    `SELECT sum(CASE WHEN label LIKE 'tool:%' THEN 1 ELSE 0 END) AS results,
            sum(CASE WHEN label LIKE 'tool-call:%' THEN 1 ELSE 0 END) AS calls
     FROM conversations WHERE created_at >= ?`,
    since,
  )

  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}`)
  console.log(`   memories   ${memories.active ?? 0} active, ${memories.derivedRows ?? 0} derived (${memories.total ?? 0} rows total)`)
  console.log(`   recall     ${recall.calls ?? 0} calls in ${days}d, ${recall.misses ?? 0} missed  (${pct(recall.misses ?? 0, recall.calls ?? 0)})`)
  if ((pairing.results ?? 0) > 0) {
    const orphans = (pairing.results ?? 0) - (pairing.calls ?? 0)
    console.log(
      `   tool rows  ${pairing.results ?? 0} results, ${pairing.calls ?? 0} calls in ${days}d` +
        `  (${pct(Math.max(0, orphans), pairing.results ?? 0)} orphaned)`,
    )
  }

  // Failed work, and WHY. A dead letter whose cause must be reconstructed from
  // rotated logs is a dead letter nobody fixes, so the reason rides the row
  // (schema v8) and surfaces here beside the counts.
  // `last_error` arrives with schema v8. This tool must keep working against a
  // store the running plugin has not upgraded yet — a diagnostic that crashes
  // on the stores you most need to look at is worse than no diagnostic.
  const hasLastError = db
    .prepare(`SELECT count(*) AS n FROM pragma_table_info('jobs') WHERE name = 'last_error'`)
    .get().n > 0
  // Report the rows, not a verdict about them. Whether a dead letter will ever
  // be worked again is decided by `jobId()`'s parts and each kind's trigger
  // (both in packages/memory/src/) — only `rebuild` carries the revision in its
  // id, so reading `expectedRevision` here answered that question for one kind
  // and guessed for the rest. Re-deriving reachability would be that rule's
  // second implementation, in a file with no tests that no new job kind is
  // obliged to update; the one case data alone can settle (an unreachable
  // rebuild) is now settled by `cleanupJobs`, which deletes the row so it never
  // reaches this list. That keeps this tool a query over stored data, as the
  // header above claims.
  const failed = db.prepare(
    `SELECT kind, attempts, completed_at,
            ${hasLastError ? 'last_error' : 'NULL AS last_error'} FROM jobs
     WHERE state = 'failed' ORDER BY completed_at DESC LIMIT 5`,
  ).all()
  for (const job of failed) {
    console.log(
      `   failed     ${job.kind} after ${job.attempts} claims, ${ago(job.completed_at)} — ` +
        `${job.last_error ?? 'cause not recorded (failed before schema v8)'}`,
    )
  }

  // The trend, not the instant: phase 4 is gated on a direction, and one
  // snapshot cannot show one.
  const weekly = db.prepare(
    `SELECT strftime('%Y-W%W', created_at/1000, 'unixepoch') AS week,
            count(*) AS calls,
            sum(CASE WHEN text LIKE ?||'%' THEN 1 ELSE 0 END) AS misses
     FROM conversations WHERE label='tool:memory_recall' AND created_at >= ?
     GROUP BY week ORDER BY week`,
  ).all(RECALL_NO_MATCH, since)
  if (weekly.length > 1) {
    console.log('   by week   ', weekly.map((w) => `${w.week.slice(5)} ${pct(w.misses, w.calls)}`).join('  '))
  }

  // A miss is one of three things and only the middle one argues for
  // embeddings (ADR 0005). Code cannot tell them apart, so print the
  // conversation around each miss and let a person judge.
  if (has('misses') && (recall.misses ?? 0) > 0) {
    const rows = db.prepare(
      `SELECT session_id, seq, created_at FROM conversations
       WHERE label='tool:memory_recall' AND text LIKE ?||'%' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 10`,
    ).all(RECALL_NO_MATCH, since)
    console.log('\n   misses, newest first — look for a reworded retry that HIT:')
    for (const row of rows) {
      const around = db.prepare(
        `SELECT seq, label, substr(text,1,90) AS text FROM conversations
         WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`,
      ).all(row.session_id, row.seq - 2, row.seq + 2)
      console.log(`   ┌ ${new Date(row.created_at).toISOString().slice(0, 16)}  ${row.session_id.slice(0, 8)}`)
      for (const line of around) {
        const mark = line.seq === row.seq ? '›' : ' '
        console.log(`   │${mark} [${line.label}] ${line.text.replace(/\s+/g, ' ')}`)
      }
    }
  }
  db.close()
}

console.log(`
Reading this (ADR 0005): a miss is either knowledge we never had, wording that
missed something we DO have, or a speculative probe. Only the middle case
argues for adding embeddings, and no number separates them — so a high rate
means read the transcripts (--misses), not "add vectors". The signal to look
for is a miss followed by a reworded retry that hit.`)
