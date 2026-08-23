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

  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}`)
  console.log(`   memories   ${memories.active ?? 0} active, ${memories.derivedRows ?? 0} derived (${memories.total ?? 0} rows total)`)
  console.log(`   recall     ${recall.calls ?? 0} calls in ${days}d, ${recall.misses ?? 0} missed  (${pct(recall.misses ?? 0, recall.calls ?? 0)})`)

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
