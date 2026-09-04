/**
 * Repo groups: a workspace declares which OTHER repositories this session may
 * READ (src/store/group.ts, service.groupMembers).
 *
 * The falsification cases (5-11) are the load-bearing ones. Cases 1-4 check
 * that the feature does what it says; 5-11 check that it cannot do what it
 * must never do — no regression to this repo's own recall, no cross-repo
 * write, no reach outside the declaration, no approval reuse across
 * repositories, no acting on a declaration other than the approved one, no
 * unbounded budget, and no ordering by an incomparable score.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryService, MemoryInputError } from '../lib/service.js'
import { clearRepoIdentityMemo, repoKeyFor } from '../lib/store/repo-key.js'
import { GROUP_FILE, readGroupDeclaration, worktreeSources } from '../lib/store/group.js'
import { runDecayJob } from '../lib/pipeline/decay.js'
import { claimNextJob, enqueueJob, jobId } from '../lib/pipeline/jobs.js'
import {
  DECAY_IDLE_MS,
  DECAY_MIN_ACTIVE,
  RECALL_FOREIGN_BUDGET_TOKENS,
  GROUP_MAX_MEMBERS,
  RECALL_RESULT_BUDGET_TOKENS,
  RECALL_PACKET_BUDGET_TOKENS,
  RECALL_PACKET_MAX_CHARS,
  ROLLUP_TARGET_CHARS,
  ROLLUP_TITLE_TARGET_CHARS,
  SCENARIO_MAX_TOKENS,
  worstForeignRowCost,
  worstPacketFillEntry,
  worstShapedBody,
} from '../lib/constants.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { registerTools, worstRecallPacketChars } from '../lib/tools.js'
import { renderFramed, FRAMING_HEADER, FRAMING_HEADER_MIXED } from '../lib/recall/inject.js'
import {
  renderEntry,
  estimateTokens,
  withinBudget,
  truncatedToBudget,
  SOURCE_LABEL_MAX_CHARS,
} from '../lib/recall/render.js'
import { DERIVED_LAYERS, DERIVED_PROVENANCE, LAYER } from '../lib/types.js'
import {
  openRegistry,
  cleanup,
  fakeAgent,
  fakeCtx,
  tempRoot,
  assertHonestRefusal,
  DERIVED_SENTENCE,
} from './helpers.mjs'

/** A real git repo with a real remote — repo-key derivation shells out to git. */
const makeRepo = (dir, remote) => {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (remote !== undefined) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  }
  return dir
}

const sourceFor = (remote) => `remote:${remote.replace(/^git@/, '').replace(':', '/').replace(/\.git$/, '')}`

/**
 * A workspace shaped like the real case that motivated this: a parent repo
 * with independent checkouts nested inside it, plus an "archived" repo that
 * has a store but NO checkout anywhere in the workspace.
 */
const setup = ({ declaration, approval = 'allowed-once' } = {}) => {
  clearRepoIdentityMemo()
  const ws = join(tempRoot(), 'fullstack')
  makeRepo(ws, 'git@github.com:acme/Parent.git')
  const backend = makeRepo(join(ws, 'Backend'), 'git@github.com:acme/Backend.git')
  const frontend = makeRepo(join(ws, 'Frontend'), 'git@github.com:acme/Frontend.git')
  // Not in the workspace at all: stands for the renamed repo whose store was
  // orphaned and whose checkout no longer exists on this machine.
  const outside = makeRepo(join(tempRoot(), 'elsewhere'), 'git@github.com:acme/Outside.git')

  const sources = {
    parent: sourceFor('git@github.com:acme/Parent.git'),
    backend: sourceFor('git@github.com:acme/Backend.git'),
    frontend: sourceFor('git@github.com:acme/Frontend.git'),
    archived: sourceFor('git@github.com:acme/Archived.git'),
    outside: sourceFor('git@github.com:acme/Outside.git'),
  }

  const { root, registry } = openRegistry()
  // Every store exists on disk BEFORE the session starts, exactly as
  // openAllKnown() would have left it. The group read path must never open.
  const stores = {}
  for (const [name, source] of Object.entries(sources)) {
    stores[name] = registry.open(repoKeyFor(source), source)
  }

  if (declaration !== undefined) {
    writeFileSync(
      join(ws, GROUP_FILE),
      typeof declaration === 'string' ? declaration : JSON.stringify(declaration),
      'utf8',
    )
  }

  const warnings = []
  const principal = fakeAgent({ id: 'principal', cwd: ws })
  const asked = []
  const base = fakeCtx({ agents: [principal] })
  const ctx = {
    ...base,
    logger: { ...base.logger, warn: (...a) => warnings.push(a.join(' ')), info: () => {} },
    get: (name) =>
      name === 'approval'
        ? approval === null
          ? undefined
          : { request: async (req) => (asked.push(req), approval) }
        : base.get?.(name),
  }

  const service = Reflect.construct(function () {}, [])
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = ctx
  service.stores = registry

  return { ws, root, registry, service, principal, sources, stores, warnings, asked, backend, frontend, outside }
}

/**
 * The REAL `memory_recall` render function, taken from the REAL registration.
 *
 * Tests that call `renderFramed` themselves cannot see `tools.ts` change: they
 * re-implement the last step instead of exercising it, so the budget the tool
 * actually passes is never under test. That gap is exactly where this round's
 * second blocker lived — the service clipped per member, and then the renderer
 * spent one shared home budget over everything.
 *
 * So the packet assertions below go through this: a stub tool registry that
 * captures what `registerTools` registers, and returns the tool's own `render`.
 */
const realRecallRender = (memory) => {
  let captured
  const ctx = {
    tools: {
      register: (tool) => {
        if (tool.name === 'memory_recall') captured = tool.output.render
      },
    },
  }
  registerTools(ctx, memory)
  assert.ok(captured, 'memory_recall must be registered with an output renderer')
  return (hits) => {
    const blocks = captured({}, { hits: hits.map((h) => ({ ...h })) })
    return blocks.map((b) => b.text).join('')
  }
}

const seed = (store, rows) => {
  const ids = []
  for (const [i, row] of rows.entries()) {
    const id = `${store.repoKey.slice(0, 8)}-${i}`
    store.db
      .prepare(
        `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, 'principal-explicit', ?, ?)`,
      )
      .run(id, row.kind ?? 'fact', store.kind === 'global' ? 'private' : 'repo-local', row.title, row.body, i, i)
    ids.push(id)
  }
  return ids
}

const GROUP_OF = (sources, extra = []) => ({
  version: 1,
  group: 'acme',
  members: [sources.backend, sources.frontend, ...extra],
})

// ---------------------------------------------------------------- 1 --------

test('1. missing / corrupt / unknown-version declaration leaves recall byte-identical, and warns', async () => {
  for (const [label, decl] of [
    ['missing', undefined],
    ['corrupt', '{ this is not json'],
    ['unknown version', { version: 99, group: 'x', members: [] }],
  ]) {
    const s = setup({ declaration: decl })
    seed(s.stores.parent, [{ title: 'parent deploy rule', body: 'parent body' }])
    seed(s.stores.backend, [{ title: 'backend deploy rule', body: 'backend body' }])

    const got = await s.service.recall({ query: 'deploy' }, s.principal)
    assert.deepEqual(
      got.hits.map((h) => h.title),
      ['parent deploy rule'],
      `${label}: only this repo's memory is returned`,
    )
    // fail open, NOT fail silent — except for absence, which is the normal
    // case and would be pure noise.
    if (label === 'missing') {
      assert.equal(s.warnings.length, 0, 'no declaration is not a warning')
    } else {
      assert.equal(s.warnings.length, 1, `${label}: exactly one warning`)
      assert.match(s.warnings[0], new RegExp(GROUP_FILE.replace('.', '\\.')))
    }
    // Never asked a human about a declaration it refused to parse.
    assert.equal(s.asked.length, 0)
    s.registry.dispose()
    cleanup(s.root)
  }
})

// ---------------------------------------------------------------- 2 --------

test('2. a valid declaration with no approval yields ZERO foreign participation in recall, list and source', async () => {
  const s = setup({ declaration: undefined, approval: 'rejected' })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  s.stores.backend.db
    .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES (?, 'session', 'sess-b')`)
    .run(backendId)

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'])

  const listings = await s.service.list(s.principal, 200)
  assert.equal(listings.filter((l) => l.scope.kind === 'group').length, 0)

  await assert.rejects(
    s.service.source(backendId, s.principal, 10),
    /no memory with id/,
    'a foreign id is not drillable without approval',
  )
  // The human WAS asked (that is the gate), and said no.
  assert.equal(s.asked.length, 1)
  s.registry.dispose()
  cleanup(s.root)
})

test('2b. a missing approval SERVICE disables the group entirely (fail closed, never degraded-open)', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }), approval: null })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'])
  assert.ok(
    s.warnings.some((w) => /approval service is absent/.test(w)),
    'says why, loudly',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// ---------------------------------------------------------------- 3 --------

test('3. after approval, foreign memories are recallable and their evidence is drillable', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(
    hits.hits.map((h) => h.title),
    ['parent deploy', 'backend deploy', 'frontend deploy'],
    'home first, then members in declaration order',
  )

  // sourceOf must reach foreign evidence, or a recallable memory would have
  // unauditable provenance (D3).
  s.stores.backend.db
    .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES (?, 'session', 'sess-b')`)
    .run(backendId)
  s.stores.backend.db
    .prepare(
      `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
       VALUES ('sess-b', 1, 1, 'user', 'human', 'the original words', 0)`,
    )
    .run()
  const turns = await s.service.source(backendId, s.principal, 10)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, 'the original words')

  // list is per-member, not merged into one bucket.
  const listings = await s.service.list(s.principal, 200)
  const group = listings.filter((l) => l.scope.kind === 'group')
  assert.deepEqual(group.map((l) => l.scope.source), [s.sources.backend, s.sources.frontend])
  s.registry.dispose()
  cleanup(s.root)
})

/**
 * The THIRD consumer of `queryAllMemories` (service.ts's member-store branch),
 * and the one whose failure mode is worst. Cases 2 and 3 above assert which
 * BUCKETS the group contributes; neither says anything about which ROWS come
 * out of a member store, so a widened layer predicate passed them both.
 *
 * Why this is the worst of the three: a leaked derived row from THIS store is
 * the one a user has no way to act on. `forget` searches `readableStores` only,
 * so a member id never reaches the derived-id branch at all and lands in the
 * foreign-repository branch instead — advice about starting a session in that
 * checkout, which cannot help with a row no session anywhere may forget.
 *
 * That misrouting is deliberately NOT asserted here. It is a defect in
 * `forget`, not an invariant, and pinning it would make this test refuse the
 * fix: measured, teaching `forget` to check `derived !== LAYER.RAW` before the
 * foreign branch turns the whole suite green except an assertion demanding the
 * OLD message. `forget`'s reasons belong to `forget`'s own cases (test 6
 * already pins the foreign message for a raw member row); this case owns one
 * claim only — which rows a member store contributes — and that claim is what
 * kills the member-branch mutant.
 */
test('3b. a member store contributes its RAW rows only', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  // Every raw write first. D9's triggers retire the whole derived layer on any
  // raw insert/update/delete, so `seed` must run before the rollup is planted
  // or the fixture would quietly hold nothing to exclude.
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])
  // `updated_at` is NEWER than every raw row here, and that direction is the
  // load-bearing part. `queryAllMemories` orders `updated_at DESC` then applies
  // `LIMIT`, so the oldest rows are the ones a cap drops: an excluded row given
  // an old timestamp sits exactly where `LIMIT` would hide a leak and hand back
  // a false green. Newest, a leak always surfaces at the head of the result.
  s.stores.backend.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES ('backend-rollup', 'fact', 'repo-local', 'active', 'backend deploy rollup', 'generated', ?, 0, 9000000000000, ?)`,
    )
    .run(DERIVED_PROVENANCE, LAYER.SCENARIO)

  assert.equal(
    s.stores.backend.db
      .prepare(`SELECT count(*) AS n FROM memories WHERE derived != ${LAYER.RAW}`)
      .get().n,
    1,
    'the rollup must really be in the member store when list() runs',
  )

  const listings = await s.service.list(s.principal, 200)
  const backend = listings.find(
    (l) => l.scope.kind === 'group' && l.scope.source === s.sources.backend,
  )
  assert.ok(backend, 'the backend member is listed')
  assert.deepEqual(
    backend.memories.map((m) => m.title),
    ['backend deploy'],
    'a member store contributes its raw active rows and nothing generated',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// ---------------------------------------------------------------- 4 --------

test('4. a mistyped member source is skipped with a warning that names the DERIVED KEY', async () => {
  const typo = 'remote:github.com/acme/Backendd'
  const s = setup({
    declaration: { version: 1, group: 'acme', members: [typo] },
  })
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'])
  const warned = s.warnings.find((w) => w.includes(typo))
  assert.ok(warned, 'the bad source is named')
  // Without the derived key a user cannot compare against repos/<key>/ to see
  // that their source string never matched anything.
  assert.ok(
    warned.includes(repoKeyFor(typo)),
    `the warning must carry the derived key ${repoKeyFor(typo)}; got: ${warned}`,
  )
  s.registry.dispose()
  cleanup(s.root)
})

// ---------------------------------------------------------------- 5 --------

test('5. ZERO REGRESSION: home delivery is identical entry-by-entry, and INDEPENDENT of foreign volume', async () => {
  // What the previous revision of this test actually proved, and did not say:
  // `recall()` always pushes home rows FIRST and `withinBudget` scans in order,
  // so home delivery was trivially unchanged by anything foreign. Comparing
  // "group on" against "group off" therefore locked the ORDER (case 11's job)
  // and said nothing whatever about the per-member budget. Measured: with
  // foreign stores unbounded (200 rows) and bounded (200 tokens), the home
  // title list was character-for-character the same either way.
  //
  // So this case now varies the thing that must not matter — foreign VOLUME —
  // across three orders of magnitude, and pins home delivery against the
  // group-off baseline for each. That is the hard gate stated as an
  // independence claim rather than an equality that could not have failed.
  const build = async (foreignRows) => {
    const withGroup = foreignRows > 0
    const s = setup({ declaration: withGroup ? GROUP_OF({ backend: '', frontend: '' }) : undefined })
    if (withGroup) writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
    // Home rows that overfill the home container on their own, so the clip is
    // genuinely exercised rather than merely not reached.
    seed(
      s.stores.parent,
      Array.from({ length: 20 }, (_, i) => ({
        title: `parent deploy topic ${i}`,
        body: 'p'.repeat(300),
      })),
    )
    for (const store of [s.stores.backend, s.stores.frontend]) {
      seed(
        store,
        Array.from({ length: foreignRows }, (_, i) => ({ title: `foreign deploy topic ${i}`, body: 'f'.repeat(120) })),
      )
    }
    const hits = (await s.service.recall({ query: 'deploy' }, s.principal)).hits
    // Count at the OUTER ruler the tool renders by (ADR 0009), not at SQL —
    // and through the tool's own renderer, so the budget it really passes is
    // what is measured.
    const packet = realRecallRender(s.service)(hits)
    const homeKey = s.stores.parent.repoKey.slice(0, 8)
    const home = hits.filter((h) => h.id.startsWith(homeKey))
    s.registry.dispose()
    cleanup(s.root)
    return {
      home: home.map((h) => h.title),
      foreign: hits.length - home.length,
      chars: packet.length,
    }
  }
  const off = await build(0)
  const few = await build(6)
  const many = await build(200)

  assert.ok(off.home.length > 0, 'the home store delivered something, or nothing below is tested')
  assert.deepEqual(few.home, off.home, "this repo's delivered entries must be identical, entry by entry")
  assert.deepEqual(
    many.home,
    off.home,
    'and must not move when a member store holds 200 rows instead of 6 — home delivery is a ' +
      'function of the home store ALONE',
  )
  assert.equal(off.foreign, 0)
  assert.ok(few.foreign > 0, 'and the group did actually add something (otherwise this asserts nothing)')
  // The per-member budget is what makes foreign volume bounded. Without it,
  // 200 foreign rows would arrive in the packet.
  assert.ok(
    many.foreign <= GROUP_MAX_MEMBERS * Math.ceil(RECALL_FOREIGN_BUDGET_TOKENS / 4),
    `foreign delivery must stay inside the per-member budgets; got ${many.foreign} rows`,
  )
  assert.ok(
    many.chars <= RECALL_PACKET_MAX_CHARS,
    `the rendered packet (${many.chars} chars) must fit the tool-result container`,
  )
})

test('5b. FOREIGN FLOOR: foreign delivery does not shrink as this repository grows', async () => {
  // The defect this case exists for: `tools.ts` used to render EVERY hit —
  // home and foreign alike — against RECALL_RESULT_BUDGET_TOKENS. That is a
  // SHARED container, so foreign rows survived only while home matched little.
  // Home was pushed first, so it never lost a row and every zero-regression
  // assertion stayed green while the feature silently delivered nothing.
  //
  // Measured under the shared ruler: 2 home rows -> 4 foreign delivered;
  // 6 home rows -> 0; 20 home rows -> 0. Approved, enabled, and empty.
  const foreignFor = async (homeRows) => {
    const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
    writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
    seed(
      s.stores.parent,
      Array.from({ length: homeRows }, (_, i) => ({ title: `parent deploy topic ${i}`, body: 'p'.repeat(260) })),
    )
    for (const store of [s.stores.backend, s.stores.frontend]) {
      seed(
        store,
        Array.from({ length: 10 }, (_, i) => ({ title: `foreign deploy topic ${i}`, body: 'f'.repeat(260) })),
      )
    }
    const hits = (await s.service.recall({ query: 'deploy' }, s.principal)).hits
    const homeKey = s.stores.parent.repoKey.slice(0, 8)
    // Count what the MODEL receives, through the TOOL'S OWN renderer — not a
    // local `renderFramed` call, which would re-implement the step under test
    // and stay green while `tools.ts` regressed to the shared home ruler.
    const packet = realRecallRender(s.service)(hits)
    const foreign = packet
      .split('\n')
      .filter((line) => line.startsWith('- [') && !line.includes(homeKey)).length
    s.registry.dispose()
    cleanup(s.root)
    return foreign
  }
  // N reaches 20: far past the point where home alone exceeds the old 500.
  const curve = []
  for (const n of [0, 2, 6, 10, 20]) curve.push([n, await foreignFor(n)])
  const baseline = curve[0][1]
  assert.ok(baseline > 0, 'a member with matching rows must deliver something at all')
  for (const [homeRows, foreign] of curve) {
    assert.equal(
      foreign,
      baseline,
      `with ${homeRows} home rows the model still receives ${baseline} foreign entries, ` +
        `not ${foreign} — foreign delivery must not be a function of home volume. ` +
        `Curve: ${JSON.stringify(curve)}`,
    )
  }
})

// ---------------------------------------------------------------- 6 --------

test('6. forget REFUSES a group member id, and the row is still active afterwards', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])

  // It is genuinely reachable by recall — so this is a real refusal, not a
  // lookup that happened to miss.
  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.ok(hits.hits.some((h) => h.id === backendId))

  await assert.rejects(
    s.service.forget(backendId, s.principal),
    (error) => {
      assert.ok(error instanceof MemoryInputError)
      assert.match(error.message, /group member repository/)
      assert.match(error.message, new RegExp(s.sources.backend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    },
  )
  // Throwing is not enough: a "delete then throw" would pass that assertion.
  const row = s.stores.backend.db
    .prepare(`SELECT status, title, body FROM memories WHERE id = ?`)
    .get(backendId)
  assert.equal(row.status, 'active', 'the foreign row must still be active')
  assert.equal(row.title, 'backend deploy', 'and its content untouched')
  s.registry.dispose()
  cleanup(s.root)
})

test('6b. an archived member says plainly that the entry cannot be forgotten at all', async () => {
  const s = setup({
    declaration: {
      version: 1,
      group: 'acme',
      members: [],
    },
  })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({
      version: 1,
      group: 'acme',
      members: [{ source: s.sources.archived, archived: true }],
    }),
    'utf8',
  )
  const [id] = seed(s.stores.archived, [{ title: 'archived deploy', body: 'a' }])
  await assert.rejects(s.service.forget(id, s.principal), /cannot be removed until a checkout/)
  assert.equal(
    s.stores.archived.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(id).status,
    'active',
  )
  s.registry.dispose()
  cleanup(s.root)
})

/**
 * 6c-6g: the refusal a member's DERIVED row gets.
 *
 * The defect these exist for, reproduced end to end before they were written.
 * `recall` hands the user a member's derived row WITH its id (test 3b's
 * comment already names the misrouting and deliberately declines to pin it),
 * and `forget` then answered with the ownership reason: "start a session
 * inside <member> and retry there". Measured: doing exactly that reaches the
 * home derived branch and answers "forget the underlying memory instead". The
 * first instruction is therefore FALSE — not vague, not incomplete, but a
 * concrete action that provably does not work. For an archived member the
 * answer was worse: "cannot be removed until a checkout of it exists again"
 * promises that a returning checkout would help, and for a derived row no
 * checkout ever helps.
 *
 * Why a member's derived row cannot simply reuse the HOME derived sentence
 * (service.ts's `row.derived !== LAYER.RAW` branch), which is the obvious
 * cheap fix and is what 6c's negative assertions exist to refuse: at home
 * "forget the underlying memory instead (recall it to get its id)" is
 * ACTIONABLE — the raw rows are in this session's hands. Across the group
 * boundary they are as unforgettable as the summary, and no derived→source
 * mapping exists in the schema, so `recall` cannot even name them. Same words,
 * opposite truth value, two input domains: not shareable.
 *
 * These cases assert the sentence, positively AND negatively. Positive-only
 * assertions would stay green if any of the three false statements came back
 * alongside the true one, which is precisely how a regression would arrive.
 */

/** RegExp-escape a source string: `.` in a host name would otherwise match anything. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Plant an active derived row of a GIVEN layer in a member store.
 *
 * `layer` is REQUIRED and has no default, deliberately. The first version of
 * this helper hardcoded `LAYER.SCENARIO` inside its `.run()` and did not even
 * accept the layer as a parameter, so every case below planted L2 and only L2.
 * Measured consequence: a mutant narrowing the production check from
 * `!== LAYER.RAW` to `=== LAYER.SCENARIO` survived the entire suite at 277/0,
 * and under it a member's L1 and L3 rows get the OWNERSHIP reason back — the
 * two sentences this round exists to delete ("Start a session inside …",
 * "cannot be removed until a checkout …") return verbatim, unobserved.
 *
 * A DEFAULT would not fix this. It would let a call site stay silent about the
 * layer and quietly re-concentrate the suite on one value, which is the same
 * failure in a new costume. Following the todo-l precedent, the fix is to
 * REMOVE the default rather than change it: every caller now states the layer
 * it is testing, and a new caller cannot forget to.
 *
 * The ordering is load-bearing: D9's triggers retire the entire derived layer
 * on any raw insert/update/delete, so every `seed` call must already have run.
 * A fixture that plants the rollup first holds nothing by the time the
 * assertion runs, and the case passes for the wrong reason.
 */
const plantDerived = (store, id, title, layer) => {
  assert.ok(
    DERIVED_LAYERS.includes(layer),
    `plantDerived needs an explicit derived layer, got ${layer}`,
  )
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', 'repo-local', 'active', ?, 'generated', ?, 0, 9000000000000, ?)`,
    )
    .run(id, title, DERIVED_PROVENANCE, layer)
  return id
}

/**
 * Sampled at the moment of the forget call, not at insert time.
 *
 * The layer is checked EXACTLY. `notEqual(row.derived, LAYER.RAW)` was the
 * original assertion, and it collapses all three derived layers into one
 * value: it cannot tell an L1 fixture from an L3 one, so against the
 * layer-coverage gap these cases now exist for it asserts nothing at all.
 */
const assertDerivedPresent = (store, id, layer) => {
  const row = store.db
    .prepare(`SELECT status, derived FROM memories WHERE id = ?`)
    .get(id)
  assert.ok(row, `the derived row ${id} must be in the member store when forget runs`)
  assert.equal(row.status, 'active', 'and active')
  assert.equal(
    row.derived,
    layer,
    `and sitting on layer ${layer} — a case that plants one layer while asserting only ` +
      '"not RAW" cannot detect a production check that covers a different layer',
  )
}

/**
 * The refusal must be true of EVERY derived layer, so there is one case per
 * layer — three independent `test()` calls, generated by this loop.
 *
 * WHY THREE TESTS AND NOT ONE TEST WITH A LOOP INSIDE. Measured, not stylistic:
 * a single case looping over the layers stops at its first failing assertion,
 * so it reports "layer 1 failed" and says NOTHING about layer 3 — whether the
 * third layer is also unguarded is unobservable from the result. Generating a
 * test per layer makes each layer its own execution point, and a mutant that
 * misses exactly one layer names that layer in the output.
 *
 * WHAT THIS EXISTS FOR. `forget`'s member branch asks `derived !== LAYER.RAW`,
 * so its declared domain is ALL THREE derived layers. Before these cases the
 * suite planted L2 and only L2, and a mutant narrowing that check to
 * `=== LAYER.SCENARIO` passed the whole suite 277/0. Probed under that mutant,
 * a member's L1 and L3 rows were answered with the OWNERSHIP reason — i.e.
 * "Start a session inside <repo> and retry there", the exact false advice this
 * round removed, resurrected on two thirds of the domain with every test green.
 *
 * That is not a neighbouring gap; it is THIS round's defect, in the round that
 * exists to fix it — the same shape as v0.4.15 (fixture only ever built
 * SCENARIO), v0.4.14 (5 states, 1 guarded) and v0.4.13 (4 read surfaces, 3
 * closed). "Unreachable today" is not a defence here (todo p), and the
 * unreachability is thin anyway: the schema's CHECK on `derived` does not
 * consult `store_kind`, so nothing at the data layer stops an L1 or L3 row
 * from sitting in a repo store — measured, all three layers INSERT fine.
 */
const LAYER_NAMES = { [LAYER.SUMMARY]: 'L1 rollup', [LAYER.SCENARIO]: 'L2 scenario', [LAYER.PERSONA]: 'L3 portrait' }

for (const layer of DERIVED_LAYERS) {
  test(`6c-${layer}. forget on a member ${LAYER_NAMES[layer]} states what is true of it, not where to go`, async () => {
    const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
    writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
    // Every RAW write first (D9), then the rollup.
    seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
    seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
    seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])
    plantDerived(s.stores.backend, 'backend-rollup', 'backend deploy rollup', layer)

    assertDerivedPresent(s.stores.backend, 'backend-rollup', layer)

    await assert.rejects(
      s.service.forget('backend-rollup', s.principal),
      (error) => {
        assert.ok(error instanceof MemoryInputError)
        // 1. It is a generated summary — the one property true of every store.
        assert.match(error.message, /generated summary/)
        // 2. Which repository, in the SAME spelling recall's `(from X)` used, so
        //    the user can match the refusal to the line they read it on. Read
        //    from the fixture, never hardcoded: a hardcoded source would keep
        //    passing if the message stopped interpolating the real one.
        assert.match(error.message, new RegExp(escapeRe(s.sources.backend)))
        // 3. No session anywhere can forget it. This is the half that kills BOTH
        //    false promises at once — "go run it there" and "wait for a
        //    checkout" are both claims that some session could.
        assert.match(error.message, /no session can forget it directly/i)
        // 4. WHY, which is the only honest reason: the whole LAYER is dropped on
        //    ANY write to that repository, so there is no row-by-row deletion to
        //    perform. Two regexes, because the sentence has two load-bearing
        //    parts and one regex would let either rot:
        //      - the UNIT is the layer, not this row;
        //      - the TRIGGER is any memory in that repository, not the set this
        //        rollup summarizes (D9 keys on any raw write, related or not).
        assert.match(error.message, /dropped as a whole layer/i)
        assert.match(error.message, /any memory in that repository/i)
        return true
      },
    )

    await assert.rejects(s.service.forget('backend-rollup', s.principal), (error) => {
      // The five statements that must NOT come back — asserted for THIS layer.
      // Without them, any could return BESIDE the true sentence and this case
      // would stay green (see M9': every positive assertion satisfied, all four
      // old falsehoods appended). The first two are also exactly what the
      // L2-only mutant put back on L1 and L3.
      assert.doesNotMatch(error.message, /Start a session inside/)
      assert.doesNotMatch(error.message, /cannot be removed until a checkout/)
      assert.doesNotMatch(error.message, /Forget the underlying memory instead/)
      assert.doesNotMatch(error.message, /recall it to get its id/)
      // The fifth is this round's own correction: "rebuilt"/"regenerated" was in
      // the first draft of the sentence and is FALSE. D9 runs a DELETE and
      // enqueues nothing; a rebuild is queued only while the packet still
      // overflows, so the layer may never return. Measured (derived 1 -> 0 while
      // `jobs` stays 0). Without this line the false word could come back.
      assert.doesNotMatch(
        error.message,
        /rebuil|regenerat/i,
        'D9 deletes the layer and queues nothing — promising a rebuild is an assurance the ' +
          'system does not make',
      )
      return true
    })

    assertDerivedPresent(s.stores.backend, 'backend-rollup', layer)
    s.registry.dispose()
    cleanup(s.root)
  })
}

test("6d. an ARCHIVED member's derived row does not promise a future checkout will help", async () => {
  // The archived case is the sharper one: `foreign.archived` used to select a
  // sentence saying the entry "cannot be removed until a checkout of it exists
  // again". For a RAW row that is true and useful. For a DERIVED row both
  // halves are false — it is not awaiting a checkout, and a checkout would
  // change nothing. So the derived branch must not consult `archived` at all:
  // the answer is identical either way, which is itself the finding.
  const s = setup({ declaration: { version: 1, group: 'acme', members: [] } })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({
      version: 1,
      group: 'acme',
      members: [{ source: s.sources.archived, archived: true }],
    }),
    'utf8',
  )
  seed(s.stores.archived, [{ title: 'archived deploy', body: 'a' }])
  plantDerived(s.stores.archived, 'archived-rollup', 'archived deploy rollup', LAYER.SCENARIO)

  assertDerivedPresent(s.stores.archived, 'archived-rollup', LAYER.SCENARIO)

  await assert.rejects(
    s.service.forget('archived-rollup', s.principal),
    (error) => {
      assert.ok(error instanceof MemoryInputError)
      assert.match(error.message, /generated summary/)
      assert.match(error.message, new RegExp(escapeRe(s.sources.archived)))
      assert.match(error.message, /no session can forget it directly/i)
      assert.match(error.message, /dropped as a whole layer/i)
      assert.match(error.message, /any memory in that repository/i)
      assert.doesNotMatch(error.message, /Start a session inside/)
      // The one this case exists for.
      assert.doesNotMatch(
        error.message,
        /cannot be removed until a checkout/,
        'an archived derived row is not waiting for a checkout — no checkout can ever forget it',
      )
      assert.doesNotMatch(error.message, /Forget the underlying memory instead/)
      assert.doesNotMatch(error.message, /recall it to get its id/)
      assert.doesNotMatch(error.message, /rebuil|regenerat/i)
      return true
    },
  )
  assertDerivedPresent(s.stores.archived, 'archived-rollup', LAYER.SCENARIO)
  s.registry.dispose()
  cleanup(s.root)
})

test('6e. REGRESSION: a member RAW row still gets the ownership reason', async () => {
  // The other side of the ruler. Making the derived sentence true must not
  // cost the raw sentence its truth: for a RAW member row the named repository
  // really is where the action can be taken, and test 6 pins that. This case
  // pins it again in the DISCRIMINATING configuration — a raw row and a derived
  // row in the SAME member store, which is where a too-eager branch swallows
  // both and a too-narrow one swallows neither.
  //
  // The derived row is load-bearing here and is now MADE so. Previously it was
  // merely planted: deleting that line left the whole suite at 277/0, i.e. the
  // configuration this case advertises never entered its judgement. So the two
  // ids are now driven through `forget` together and their answers compared —
  // one store, two rows, two different sentences, which is the actual claim.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  plantDerived(s.stores.backend, 'backend-rollup', 'backend deploy rollup', LAYER.SCENARIO)
  // Sampled at forget time: D9 retires the derived layer on any raw write, so
  // a fixture that plants it before `seed` would hold nothing by now.
  assertDerivedPresent(s.stores.backend, 'backend-rollup', LAYER.SCENARIO)

  await assert.rejects(
    s.service.forget(backendId, s.principal),
    (error) => {
      assert.ok(error instanceof MemoryInputError)
      assert.match(error.message, /belongs to group member repository/)
      assert.match(error.message, new RegExp(escapeRe(s.sources.backend)))
      assert.match(error.message, /Start a session inside/)
      // And it must NOT have drifted onto the derived sentence.
      assert.doesNotMatch(error.message, /no session can forget it directly/i)
      return true
    },
  )
  // The derived row in the SAME store must get the OTHER sentence. This is what
  // makes the planted row participate: the case now fails if the two rows are
  // answered alike, which is exactly what a branch covering the wrong set does.
  await assert.rejects(
    s.service.forget('backend-rollup', s.principal),
    (error) => {
      assert.match(error.message, /generated summary in group member repository/)
      assert.doesNotMatch(error.message, /Start a session inside/)
      return true
    },
  )
  assert.equal(
    s.stores.backend.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(backendId).status,
    'active',
  )
  assertDerivedPresent(s.stores.backend, 'backend-rollup', LAYER.SCENARIO)
  s.registry.dispose()
  cleanup(s.root)
})

test('6f. the derived refusal writes NOTHING to the member store', async () => {
  // Test 17's discipline, applied to the new branch. The branch reads a member
  // store to decide WHICH sentence to say, and a read that decides something
  // is exactly where a write sneaks in (17 exists because `touchUsage` did
  // precisely that on the recall path). "We did not call a writer" is not the
  // assertion — it is unobservable and re-encodes the implementation. The
  // assertion is the promise a human approved: the FILE bytes must not move.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  const [frontendId] = seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])
  plantDerived(s.stores.backend, 'backend-rollup', 'backend deploy rollup', LAYER.SCENARIO)
  plantDerived(s.stores.frontend, 'frontend-rollup', 'frontend deploy rollup', LAYER.SCENARIO)

  const memberFiles = {
    backend: join(s.root, 'repos', repoKeyFor(s.sources.backend), 'memory.sqlite'),
    frontend: join(s.root, 'repos', repoKeyFor(s.sources.frontend), 'memory.sqlite'),
  }
  // WAL: the changed bytes can sit in `-wal` rather than the main file, so a
  // naive digest of `memory.sqlite` alone would pass over a real write. Both
  // files are digested, after a TRUNCATE checkpoint.
  const digest = () => {
    const out = {}
    for (const [name, file] of Object.entries(memberFiles)) {
      s.stores[name].db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      out[name] = createHash('md5').update(readFileSync(file)).digest('hex')
      const wal = `${file}-wal`
      out[`${name}-wal`] = existsSync(wal)
        ? createHash('md5').update(readFileSync(wal)).digest('hex')
        : 'absent'
    }
    return out
  }
  // Row-level snapshots too: a digest says THAT something moved, these say WHAT.
  const rows = () => {
    const out = {}
    for (const name of Object.keys(memberFiles)) {
      out[name] = {
        memories: s.stores[name].db
          .prepare(`SELECT id, status, title, body, derived, updated_at FROM memories ORDER BY id`)
          .all(),
        usage: s.stores[name].db
          .prepare(`SELECT memory_id, retrieved, last_hit_at FROM usage ORDER BY memory_id`)
          .all(),
        revision: s.stores[name].db
          .prepare(`SELECT v FROM meta WHERE k = 'store_revision'`)
          .get() ?? null,
      }
    }
    return out
  }

  const beforeDigest = digest()
  const beforeRows = rows()

  // All four refusal shapes, both kinds of row, both members.
  //
  // The refusals are CAPTURED and classified, not merely awaited. `await
  // assert.rejects(..., MemoryInputError)` was the first version of this loop
  // and it was VACUOUS: the fail-closed `no memory with id X` is also a
  // MemoryInputError, so that assertion could not tell whether the member
  // branch had been reached at all. Two probes proved it — deleting the loop
  // outright, and pointing it at four ids that exist nowhere, BOTH left this
  // case green. A byte-comparison test whose subject never runs compares a
  // store against itself and always passes.
  const seen = []
  for (const id of ['backend-rollup', 'frontend-rollup', backendId, frontendId]) {
    await assert.rejects(s.service.forget(id, s.principal), (error) => {
      seen.push(error.message)
      return error instanceof MemoryInputError
    })
  }
  assert.equal(
    seen.filter((m) => /generated summary in group member repository/.test(m)).length,
    2,
    'both member DERIVED rows must have been refused by the derived branch',
  )
  assert.equal(
    seen.filter((m) => /belongs to group member repository/.test(m)).length,
    2,
    'both member RAW rows must have been refused by the ownership branch',
  )
  assert.equal(
    seen.filter((m) => /^no memory with id/.test(m)).length,
    0,
    'no refusal may come from the fail-closed path — that would mean the ids never reached ' +
      'a member store, and the byte comparison below would be measuring nothing',
  )

  const afterDigest = digest()
  const afterRows = rows()

  assert.deepEqual(
    afterDigest,
    beforeDigest,
    'a refusal read a member store to choose its wording and changed its bytes; the approval ' +
      'prompt promises "Nothing is ever written to them"',
  )
  for (const name of Object.keys(memberFiles)) {
    assert.deepEqual(afterRows[name].memories, beforeRows[name].memories, `${name}: memories moved`)
    assert.deepEqual(afterRows[name].usage, beforeRows[name].usage, `${name}: usage rows moved`)
    assert.deepEqual(
      afterRows[name].revision,
      beforeRows[name].revision,
      `${name}: meta.store_revision moved, so a trigger fired on a read-only path`,
    )
  }
  s.registry.dispose()
  cleanup(s.root)
})

test('6g. memory_forget share:true on a member derived row is refused too', async () => {
  // `memory_forget` offers TWO actions, not one: `share: true` bypasses
  // forget() entirely and calls share() directly (tools.ts). It is the same
  // tool, the same id parameter, and the same id a user just read out of
  // recall — so it is a second door onto this row and belongs in this round's
  // evidence even though it needs no change. share() resolves through
  // storeFor(), which never sees members, so the member row is invisible to it
  // and the refusal is the generic fail-closed one. Recorded as measured, not
  // assumed: what matters is that it refuses and touches nothing.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  plantDerived(s.stores.backend, 'backend-rollup', 'backend deploy rollup', LAYER.SCENARIO)

  let forgetTool
  registerTools(
    { tools: { register: (tool) => { if (tool.name === 'memory_forget') forgetTool = tool } } },
    s.service,
  )
  assert.ok(forgetTool, 'memory_forget must be registered')

  await assert.rejects(
    forgetTool.execute(
      { id: 'backend-rollup', share: true },
      { agent: s.principal, signal: new AbortController().signal },
    ),
    (error) => {
      assert.ok(error instanceof MemoryInputError)
      assert.match(error.message, /no memory with id backend-rollup in this repository/)
      return true
    },
  )
  // Fail closed: no approval was even requested for a row this session cannot
  // act on, and the member row is untouched.
  assert.equal(s.asked.length, 0, 'no human was prompted about a row this session cannot reach')
  assertDerivedPresent(s.stores.backend, 'backend-rollup', LAYER.SCENARIO)
  s.registry.dispose()
  cleanup(s.root)
})

/**
 * 6h. `sourceOf` reaches into member stores (`service.source` iterates
 * `[...readableStores, ...groupStores]`), so the sentence it returns for a row
 * with no source has TWO input domains — and v0.4.16's whole lesson is that a
 * sentence whose truth value FLIPS between them must not be shared.
 *
 * WHY IT IS SHARED HERE, AND WHY THAT IS NOT THE v0.4.16 MISTAKE REPEATED. The
 * sentence that flipped in v0.4.16 was ADVICE — "start a session inside that
 * checkout and retry" is true at home and false across the boundary, because it
 * claims something a session can DO. These sentences claim nothing about what
 * any session can do: they say what the ROW IS ("a generated summary, not a
 * memory recorded from a conversation"). Being a generated summary is a
 * property of the row, not of the reader's access to it, so there is no half
 * that can be false in one domain. This case is the measurement of that claim
 * rather than the reasoning for it — the same wording, asserted in the member
 * domain.
 *
 * ⛔ THE SENTENCE ASSERTED HERE IS IMPORTED, NOT COPIED (rework, step 3c). It
 * used to be a hardcoded literal ending `…so it has no source passage of its
 * own.`, and that clause turned out to be FALSE for a derived row whose only
 * evidence is `commit`/`file`/`url` — `evidence.excerpt` there holds a real
 * recorded passage (measured 9/9 across L1/L2/L3 x the three kinds). A
 * hardcoded copy in this file would have gone on asserting the false sentence
 * after `service.ts` was corrected, so the expected bytes come from
 * `DERIVED_SENTENCE` in `./helpers.mjs`, which `layers.test.mjs` uses too.
 *
 * It also carries test 17's discipline: the branch READS a member store to
 * choose its wording, and a read that decides something is exactly where a
 * write sneaks in. "We did not call a writer" is unobservable and re-encodes
 * the implementation; the assertion is the promise a human approved — the FILE
 * bytes must not move.
 *
 * BOTH MEMBER KINDS, live and archived (rework, step 3b). v0.4.16 found the
 * ARCHIVED member to be the sharper case: `foreign.archived` selected a second
 * sentence there, and both of that sentence's halves were false. The argument
 * above — "these sentences make no claim about what a session can DO, so they
 * cannot flip" — is stated over BOTH domains, and only the live one was
 * measured. An argument advanced in a comment and checked on one of its two
 * domains is exactly the shape this rework exists to remove, so the archived
 * member is measured too: for `source` the sentence must be the SAME, which is
 * itself the finding (unlike `forget`, this answer does not consult
 * `archived`, and must not start to).
 */
const SOURCE_MEMBER_DOMAINS = [
  {
    name: 'live',
    store: 'backend',
    source: (s) => s.sources.backend,
    declare: (s) => GROUP_OF(s.sources),
  },
  {
    name: 'archived',
    store: 'archived',
    source: (s) => s.sources.archived,
    // No checkout of it exists anywhere in the workspace — that is what makes
    // it archived, and 6b/6d use the same fixture.
    declare: (s) => ({
      version: 1,
      group: 'acme',
      members: [{ source: s.sources.archived, archived: true }],
    }),
  },
]

for (const domain of SOURCE_MEMBER_DOMAINS) {
  for (const layer of DERIVED_LAYERS) {
    test(`6h-${domain.name}-${layer}. sourceOf on a ${domain.name} member's ${LAYER_NAMES[layer]} says what it IS, and writes nothing there`, async () => {
      const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
      writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(domain.declare(s)), 'utf8')
      const member = s.stores[domain.store]
      // Every RAW write first (D9), then the derived plant — in that order, or
      // the trigger deletes the layer and this case measures an absent row.
      seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
      seed(member, [{ title: `${domain.store} deploy`, body: 'b' }])
      plantDerived(member, 'member-rollup', `${domain.store} deploy rollup`, layer)
      assertDerivedPresent(member, 'member-rollup', layer)

      const file = join(s.root, 'repos', repoKeyFor(domain.source(s)), 'memory.sqlite')
      // WAL: changed bytes can sit in `-wal` rather than the main file, so a
      // digest of `memory.sqlite` alone would pass over a real write.
      const digest = () => {
        member.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const wal = `${file}-wal`
        return {
          main: createHash('md5').update(readFileSync(file)).digest('hex'),
          wal: existsSync(wal)
            ? createHash('md5').update(readFileSync(wal)).digest('hex')
            : 'absent',
          revision: member.db.prepare(`SELECT v FROM meta WHERE k = 'store_revision'`).get() ?? null,
        }
      }
      const before = digest()

      // CAPTURED and classified, never `assert.rejects(p, MemoryInputError)`:
      // the fail-closed `no memory with id X` is also a MemoryInputError, so that
      // form cannot tell whether the member store was reached at all — and a byte
      // comparison whose subject never ran compares a store against itself and
      // always passes (the exact vacuity that killed v0.4.16's test 6f).
      let message
      await assert.rejects(s.service.source('member-rollup', s.principal, 8), (error) => {
        assert.ok(error instanceof MemoryInputError)
        message = error.message
        return true
      })
      // ⛔ FOLDED INTO THE SHARED HELPER (rework, step 3c). This block used to
      // RE-IMPLEMENT nine of `assertHonestRefusal`'s assertions inline, plus a
      // HARDCODED copy of the derived sentence — precisely the drift the shared
      // helper exists to prevent, and the copy is what makes it dangerous: when
      // the derived wording was reworked this round, an inline literal here
      // would have kept asserting the OLD, FALSE sentence, leaving one file
      // green while the other moved. Both files now import one definition and
      // one `DERIVED_SENTENCE` from `./helpers.mjs`.
      //
      // `assertHonestRefusal` subsumes every assertion this block used to make:
      // `no memory with id` (the fail-closed path — without it the id never
      // reached the member store and everything below measures nothing), the
      // five false-advice negatives, the "unaffected" clause, the destruction
      // guard, and the WHOLE SENTENCE byte-for-byte, which is the claim under
      // test in this domain: an appended clause that is true at home and false
      // here cannot survive full equality.
      assertHonestRefusal(message, 'member-rollup', DERIVED_SENTENCE('member-rollup'))

      assert.deepEqual(
        digest(),
        before,
        'a read that chose its wording from a member store changed that store\'s bytes; the ' +
          'approval prompt promises "nothing is ever written to them"',
      )
      assertDerivedPresent(member, 'member-rollup', layer)
      s.registry.dispose()
      cleanup(s.root)
    })
  }
}

// ---------------------------------------------------------------- 7 --------

test('7. ADDRESSING: an undeclared repository with a store on disk never participates', async () => {
  // `outside` has a store and is a real checkout — just not declared, and not
  // in this workspace. It must be unreachable.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.outside, [{ title: 'outside deploy', body: 'o' }])
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.equal(hits.hits.filter((h) => h.title === 'outside deploy').length, 0)

  // And the walk that VALIDATES declarations must not have discovered it
  // either — enumeration is validation input, never a member source.
  const found = worktreeSources(s.ws)
  assert.ok(found.has(s.sources.backend))
  assert.ok(!found.has(s.sources.outside), 'the walk stays inside the workspace')

  // THE probe that matters, and it must sit INSIDE the workspace. `outside`
  // above cannot test the rule this case is named for: the walk never reaches
  // it, so "an undeclared repo does not participate" passes for the wrong
  // reason — because it was never enumerated, not because enumeration is
  // refused as a source. `Undeclared` IS enumerated (it is a real checkout in
  // the tree) and is still absent from the declaration, so it is the only
  // subject that can distinguish the two.
  const undeclared = makeRepo(join(s.ws, 'Undeclared'), 'git@github.com:acme/Undeclared.git')
  assert.ok(undeclared, 'the probe repository was created')
  clearRepoIdentityMemo()
  const undeclaredSource = sourceFor('git@github.com:acme/Undeclared.git')
  const undeclaredStore = s.registry.open(repoKeyFor(undeclaredSource), undeclaredSource)
  seed(undeclaredStore, [{ title: 'undeclared deploy', body: 'u' }])

  const inTree = worktreeSources(s.ws)
  assert.ok(
    inTree.has(undeclaredSource),
    'the probe really is discoverable — otherwise this asserts nothing',
  )

  const s2 = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s2.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s2.sources)), 'utf8')
  const probe = makeRepo(join(s2.ws, 'Undeclared'), 'git@github.com:acme/Undeclared.git')
  assert.ok(probe)
  clearRepoIdentityMemo()
  const probeStore = s2.registry.open(repoKeyFor(undeclaredSource), undeclaredSource)
  seed(probeStore, [{ title: 'undeclared deploy', body: 'u' }])
  const got = await s2.service.recall({ query: 'deploy' }, s2.principal)
  assert.equal(
    got.hits.filter((h) => h.title === 'undeclared deploy').length,
    0,
    'a repository that IS a checkout in this workspace, and IS enumerated, still does not ' +
      'participate unless the declaration names it — enumeration validates, it never admits',
  )
  s2.registry.dispose()
  cleanup(s2.root)
  s.registry.dispose()
  cleanup(s.root)
})

test('7b. a repo OUTSIDE the workspace passes the archived predicate — the approval prompt is what stops it', async () => {
  // Documented as designed, not papered over: `archived` asserts only "has a
  // store, is not a checkout here", which `outside` satisfies. The predicate
  // does NOT verify the human's real claim, so the honest test is that it
  // PASSES the predicate and is still surfaced to a person, and that a refusal
  // yields zero participation.
  const s = setup({ approval: 'rejected' })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [{ source: s.sources.outside, archived: true }] }),
    'utf8',
  )
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  seed(s.stores.outside, [{ title: 'outside deploy', body: 'o' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'], 'not approved ⇒ zero participation')
  assert.equal(s.asked.length, 1, 'the predicate passed it; a human was asked')
  assert.match(s.asked[0].reason, /ARCHIVED/, 'and the prompt flags it as an unverifiable claim')
  assert.match(
    s.asked[0].reason,
    new RegExp(s.sources.outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'listing the member by name, individually',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// ---------------------------------------------------------------- 8 --------

test('8. approval does NOT carry across host repositories: the same members must be re-approved elsewhere', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])

  await s.service.recall({ query: 'deploy' }, s.principal)
  assert.equal(s.asked.length, 1)

  // A DIFFERENT repository, same member set, same service instance.
  const other = makeRepo(join(tempRoot(), 'other'), 'git@github.com:acme/Other.git')
  s.registry.open(repoKeyFor(sourceFor('git@github.com:acme/Other.git')), sourceFor('git@github.com:acme/Other.git'))
  writeFileSync(join(other, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  // Backend is not nested under `other`, so declare it archived to isolate the
  // question to approval reuse rather than admission.
  writeFileSync(
    join(other, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [{ source: s.sources.backend, archived: true }] }),
    'utf8',
  )
  const second = fakeAgent({ id: 'second', cwd: other })
  const live = new Map([[s.principal.id, s.principal], [second.id, second]])
  s.service.ctx.agents.get = (id) => live.get(id)
  s.service.ctx.agents.list = () => [...live.values()]
  await s.service.recall({ query: 'deploy' }, second)
  assert.equal(s.asked.length, 2, 'a grant in one repository is not a grant in another')
  s.registry.dispose()
  cleanup(s.root)
})

// ---------------------------------------------------------------- 9 --------

test('9. TOCTOU: editing the declaration after approval does not change what this session uses', async () => {
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [s.sources.backend] }),
    'utf8',
  )
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])

  const before = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(before.hits.map((h) => h.title), ['backend deploy'])
  const approvedFingerprint = readGroupDeclaration(s.ws, { warn() {}, info() {} }).fingerprint

  // Swap in a broader declaration AFTER approval.
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify(GROUP_OF(s.sources)),
    'utf8',
  )
  const after = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(
    after.hits.map((h) => h.title),
    ['backend deploy'],
    'the session keeps using the content that was approved',
  )
  assert.equal(s.asked.length, 1, 'and does not silently re-approve')
  // The fingerprint is what makes that checkable rather than incidental.
  assert.notEqual(
    approvedFingerprint,
    readGroupDeclaration(s.ws, { warn() {}, info() {} }).fingerprint,
    'the file really did change',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 10 --------

test('10. the worst recall PACKET is priced at load against the real container, and the bound BINDS', async () => {
  // The per-member budget must admit at least one worst-SHAPED foreign row.
  // Shaped, not 'x'.repeat(n): renderEntry indents a body's own newlines
  // (\n -> \n + 2 spaces), and a single-line synthetic body is blind to that
  // entire dimension — the exact false-green ADR 0007 records.
  //
  // The shape is built by the PRODUCTION helper, and the targets are the
  // PRODUCTION constants. The previous revision inlined a second copy of
  // `worstShapedBody` and hardcoded 620/60 beside it — the same rule written
  // twice and the same number typed twice, which is the D8 hazard this suite
  // exists to catch elsewhere.
  // The worst foreign row also carries a `(from …)` source label at its
  // ceiling: a foreign entry is the only entry that renders one, and it is
  // what makes the packet say whose memory it is showing. Pricing this shape
  // WITHOUT the label is how the budget would silently stop admitting the row
  // it exists to admit.
  //
  // What "worst" MEANS here changed with the write path. The bound the writer
  // enforces is now `SCENARIO_MAX_TOKENS` on the RENDERED entry, not
  // `ROLLUP_TARGET_CHARS` on the stored string, so the dearest foreign row is
  // no longer "the longest legal body" — it is "the body that saturates the
  // injection cap", which is a different string and costs more. Asserting the
  // old shape would now price a row the writer cannot produce and would
  // UNDER-price the one it can.
  const asStored = (body) =>
    truncatedToBudget(
      { id: '', kind: 'fact', title: 'x'.repeat(ROLLUP_TITLE_TARGET_CHARS), body },
      SCENARIO_MAX_TOKENS,
    )
  const foreign = (stored) => ({
    id: '123e4567-e89b-12d3-a456-426614174000',
    kind: 'fact',
    title: 'x'.repeat(ROLLUP_TITLE_TARGET_CHARS),
    body: stored.body,
    source: 'x'.repeat(SOURCE_LABEL_MAX_CHARS),
  })
  const row = foreign(asStored(worstShapedBody(ROLLUP_TARGET_CHARS * 4)))
  const shapedCost = estimateTokens(renderEntry(row, true))
  const flatCost = estimateTokens(
    renderEntry({ ...row, body: 'x'.repeat(ROLLUP_TARGET_CHARS) }, true),
  )
  assert.ok(shapedCost > flatCost, 'the shaped body really is dearer, or this test proves nothing')
  assert.equal(worstForeignRowCost(), shapedCost, 'the guard prices this shape')

  // The bound BINDS, which is the claim the title makes and the one the old
  // fixed shape stopped supporting: every body the write path can store must
  // price at or under it on the recall path. Candidates span the dimensions
  // that pull in opposite directions — length, newline density, and the
  // previously-assumed worst case — so a guard priced on any single one of
  // them fails here rather than passing by coincidence.
  for (const [name, body] of [
    ['the old character-shaped worst case', worstShapedBody(ROLLUP_TARGET_CHARS)],
    ['a flat body at the old target', 'x'.repeat(ROLLUP_TARGET_CHARS)],
    ['an all-newline body', '\n'.repeat(4 * SCENARIO_MAX_TOKENS)],
    ['a body far past any target', worstShapedBody(ROLLUP_TARGET_CHARS * 6)],
    ['a one-word-per-line list', 'word\n'.repeat(400)],
  ]) {
    const stored = asStored(body)
    assert.ok(stored !== undefined, `${name}: the writer can store something`)
    assert.ok(
      estimateTokens(renderEntry({ ...foreign(stored), source: undefined, id: '' }, false)) <=
        SCENARIO_MAX_TOKENS,
      `${name}: precondition — the write path really did bound it`,
    )
    assert.ok(
      estimateTokens(renderEntry(foreign(stored), true)) <= worstForeignRowCost(),
      `${name}: costs ${estimateTokens(renderEntry(foreign(stored), true))} on the recall ` +
        `path, above the guard's ${worstForeignRowCost()} — the floor does not bound it`,
    )
  }
  // The label is not free, and the guard must be pricing it rather than a
  // bare row that happens to fit: without this, dropping `source` from the
  // guard's shape would leave every assertion here green while the budget
  // under-priced every foreign entry the tool renders.
  const unlabelledCost = estimateTokens(renderEntry({ ...row, source: undefined }, true))
  assert.ok(
    shapedCost > unlabelledCost,
    `the source label must cost something (${shapedCost} vs ${unlabelledCost}) — a guard that ` +
      'prices an unlabelled row prices a string the recall tool never emits',
  )
  assert.ok(
    RECALL_FOREIGN_BUDGET_TOKENS >= shapedCost,
    `per-member budget ${RECALL_FOREIGN_BUDGET_TOKENS} must admit one worst-shaped row (${shapedCost})`,
  )
  // And the row genuinely fits through the real selector, not just the sum.
  assert.equal(withinBudget([row], RECALL_FOREIGN_BUDGET_TOKENS, true).length, 1)

  // The packet budget is DERIVED from the containers the service already spent,
  // so the renderer can never clip a row the service admitted.
  assert.equal(
    RECALL_PACKET_BUDGET_TOKENS,
    RECALL_RESULT_BUDGET_TOKENS + GROUP_MAX_MEMBERS * RECALL_FOREIGN_BUDGET_TOKENS,
    'the packet budget is the sum of the per-store containers, not an independent number',
  )

  // The load-time guard prices a REAL rendered packet against a REAL container.
  assert.ok(
    worstRecallPacketChars() <= RECALL_PACKET_MAX_CHARS,
    `worst packet ${worstRecallPacketChars()} chars must fit ${RECALL_PACKET_MAX_CHARS}`,
  )
})

test('10b. the packet guard is NOT VACUOUS: one more member overflows the container', async () => {
  // This is the case the previous guard could not have had. It asserted
  //     R + N*F > R*(N+1)
  // which reduces to N*F > N*R, i.e. F > R — N cancels entirely. It therefore
  // certified GROUP_MAX_MEMBERS = 100000 (a 20,000,500-token worst case) with
  // all 190 tests green, while its comment claimed the bound was checked.
  //
  // A guard is only a guard if some reachable value trips it. So this rebuilds
  // the guard's own arithmetic at N and N+1 and requires the bound to FLIP.
  const packetChars = (members) => {
    const entry = worstPacketFillEntry()
    const fill = (budget) => Array.from({ length: Math.floor(budget / 4) }, () => entry)
    const hits = [
      ...fill(RECALL_RESULT_BUDGET_TOKENS),
      ...Array.from({ length: members }, () => fill(RECALL_FOREIGN_BUDGET_TOKENS)).flat(),
    ]
    const budget = RECALL_RESULT_BUDGET_TOKENS + members * RECALL_FOREIGN_BUDGET_TOKENS
    return renderFramed(hits, budget, true).length
  }
  // The shipped value is the guard's own number, recomputed independently here.
  assert.equal(
    packetChars(GROUP_MAX_MEMBERS),
    worstRecallPacketChars(),
    'this test rebuilds exactly the packet the guard prices',
  )
  assert.ok(
    packetChars(GROUP_MAX_MEMBERS) <= RECALL_PACKET_MAX_CHARS,
    'the shipped member count fits',
  )
  assert.ok(
    packetChars(GROUP_MAX_MEMBERS + 1) > RECALL_PACKET_MAX_CHARS,
    `GROUP_MAX_MEMBERS (${GROUP_MAX_MEMBERS}) must be the LARGEST value that fits ` +
      `${RECALL_PACKET_MAX_CHARS} chars — at ${GROUP_MAX_MEMBERS + 1} the packet is ` +
      `${packetChars(GROUP_MAX_MEMBERS + 1)} chars and the guard must throw. A cap that ` +
      'nothing can violate is not a cap.',
  )
})

test('10c. the guard ITSELF throws on an over-sized member count (not merely the arithmetic)', async () => {
  // 10b checks the RELATIONSHIP between the constants. It cannot check that the
  // shipped `if` actually fires — and that distinction is the entire lesson of
  // this round: the previous guard's arithmetic was self-consistent and its
  // condition was still unreachable. Restoring the old formula leaves 10b green.
  //
  // So this loads the real module with a raised GROUP_MAX_MEMBERS and requires
  // the LOAD to fail. It is the only assertion here that would have caught
  // `GROUP_MAX_MEMBERS = 100000` sailing through with the suite green.
  //
  // The copy is placed inside the package so `node_modules` still resolves
  // upward from it, and the mutation is applied to the built JS the same way a
  // careless edit to the source would reach it.
  const libDir = join(import.meta.dirname, '..', 'lib')
  const original = readFileSync(join(libDir, 'constants.js'), 'utf8')
  assert.match(
    original,
    /export const GROUP_MAX_MEMBERS = \d+;/,
    'the probe must find the constant it intends to raise',
  )
  // Each variant is a SIBLING of lib/, never nested inside another probe, so
  // `node_modules` still resolves upward from the package root.
  const probes = []
  try {
    for (const raised of [GROUP_MAX_MEMBERS + 1, 100_000]) {
      const dir = join(import.meta.dirname, '..', `lib-guard-probe-${process.pid}-${raised}`)
      probes.push(dir)
      cpSync(libDir, dir, { recursive: true })
      writeFileSync(
        join(dir, 'constants.js'),
        original.replace(
          /export const GROUP_MAX_MEMBERS = \d+;/,
          `export const GROUP_MAX_MEMBERS = ${raised};`,
        ),
        'utf8',
      )
      await assert.rejects(
        import(pathToFileURL(join(dir, 'tools.js')).href),
        (error) => {
          assert.match(
            error.message,
            /worst recall packet renders \d+ characters/,
            `loading with GROUP_MAX_MEMBERS = ${raised} must throw the packet guard`,
          )
          return true
        },
        `GROUP_MAX_MEMBERS = ${raised} must be REJECTED AT LOAD. The previous guard accepted ` +
          'it silently, because its condition reduced to `F > R` with the member count ' +
          'cancelled out.',
      )
    }
    // Control: the SAME copy machinery with the SHIPPED value must load
    // cleanly, so the rejections above are the guard and not the scaffolding.
    const control = join(import.meta.dirname, '..', `lib-guard-probe-${process.pid}-control`)
    probes.push(control)
    cpSync(libDir, control, { recursive: true })
    await import(pathToFileURL(join(control, 'tools.js')).href)
  } finally {
    for (const dir of probes) rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- 11 --------

test('11. ordering is positional, never by the incomparable cross-store rank', async () => {
  // FTS5 rank is negative BM25 and its IDF is per-store: a word that is
  // CENTRAL to a repository has high df/N there, hence low IDF, hence a WORSE
  // rank than a repo with one incidental mention. Measured on the real stores:
  // 85.2% of queries invert. So a home row must never be pushed behind a
  // foreign row because the foreign store scored it "better".
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [s.sources.backend] }),
    'utf8',
  )
  // Home store: "deploy" is the SUBJECT — high df/N, therefore low IDF and a
  // numerically worse rank.
  seed(
    s.stores.parent,
    Array.from({ length: 12 }, (_, i) => ({ title: `deploy runbook step ${i}`, body: 'deploy deploy deploy' })),
  )
  // Foreign store: exactly one incidental mention — high IDF, "best" rank.
  seed(s.stores.backend, [
    { title: 'unrelated caching note', body: 'mentions deploy once' },
    ...Array.from({ length: 11 }, (_, i) => ({ title: `caching note ${i}`, body: 'nothing relevant here' })),
  ])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  const firstForeign = hits.hits.findIndex((h) => h.id.startsWith(s.stores.backend.repoKey.slice(0, 8)))
  const homeCount = hits.hits.filter((h) => h.id.startsWith(s.stores.parent.repoKey.slice(0, 8))).length
  assert.ok(homeCount > 0 && firstForeign > 0, 'both stores contributed')
  assert.equal(
    firstForeign,
    homeCount,
    'every home hit precedes every foreign hit — no global rank reordering',
  )
  // Deliberately NOT asserted: any ordering AMONG the foreign hits relative to
  // home by score. Asserting a cross-store rank order would lock in the very
  // comparability this test exists to deny.
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 12 --------

test('12. ADMISSION RULE (a): a non-archived member with no checkout here is REFUSED, not silently admitted', async () => {
  // The mutation this exists to kill: deleting rule (a) (`} else if (!inWorktree)`).
  // With it gone, a member that is NOT a checkout in this workspace is admitted
  // as a WORKTREE member — so the approval prompt describes it as "(checked out
  // inside this workspace)" and the ARCHIVED sentence never appears. That
  // sentence is the only part of the prompt a human can actually judge, because
  // the archived predicate verifies almost nothing. The whole 190-case suite
  // passed with the rule deleted.
  //
  // Asserting only "it was skipped" is not enough: the honest failure is about
  // what the HUMAN IS TOLD, so this pins the prompt text too.
  const s = setup({ approval: 'rejected' })
  // `outside` is a real checkout with a real store, but NOT inside this
  // workspace, and it is declared WITHOUT `archived`.
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [s.sources.outside] }),
    'utf8',
  )
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  seed(s.stores.outside, [{ title: 'outside deploy', body: 'o' }])

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(
    hits.hits.map((h) => h.title),
    ['parent deploy'],
    'a non-archived member that is not a checkout here must not participate',
  )
  // Refused BEFORE the human is bothered: there is no member left to approve,
  // so no prompt is raised at all.
  assert.equal(
    s.asked.length,
    0,
    'rule (a) refuses the member outright; a human is never asked to approve it',
  )
  const warned = s.warnings.find((w) => w.includes(s.sources.outside))
  assert.ok(warned, 'and it says which member was refused')
  assert.match(
    warned,
    /is not a git checkout inside this workspace/,
    'naming the actual reason, so a user can fix the declaration',
  )
  s.registry.dispose()
  cleanup(s.root)
})

test('12b. an admitted member is never described to the human as a worktree checkout unless it IS one', async () => {
  // The same mutation seen from the prompt side, with the member ACTUALLY
  // admitted so the prompt is really built. Declared `archived: true`, so it
  // passes admission — and must be labelled ARCHIVED, individually, by name.
  const s = setup({ approval: 'rejected' })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [{ source: s.sources.outside, archived: true }] }),
    'utf8',
  )
  seed(s.stores.outside, [{ title: 'outside deploy', body: 'o' }])
  await s.service.recall({ query: 'deploy' }, s.principal)

  assert.equal(s.asked.length, 1, 'the human was asked')
  const line = s.asked[0].reason
    .split('\n')
    .find((l) => l.includes(s.sources.outside))
  assert.ok(line, 'the member is listed individually, by name')
  assert.match(line, /ARCHIVED/, 'a member with no checkout here must carry the ARCHIVED warning')
  assert.doesNotMatch(
    line,
    /checked out inside this workspace/,
    'and must NEVER be described as a checkout in this workspace — that is the sentence a ' +
      'person uses to decide, and it would be a lie',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 13 --------

test('13. the read path never CREATES a store: a declaration cannot conjure a repository', async () => {
  // The mutation this exists to kill: `stores.get(key)` -> `stores.open(key, source)`
  // on the read path. `open()` mkdirs and migrates, so a declaration naming a
  // source that never existed would CREATE a store for it — the declaration
  // file, which is committed repo content, becomes able to write to the
  // harness home. The whole suite passed with `open()` substituted, because
  // every existing case names a store that already exists.
  //
  // So the subject here is a member whose store does NOT exist, and the
  // assertion is a filesystem probe: no directory may appear.
  const s = setup()
  const ghost = 'remote:github.com/acme/NeverExisted'
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [{ source: ghost, archived: true }] }),
    'utf8',
  )
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])

  const ghostKey = repoKeyFor(ghost)
  const ghostDir = join(s.root, 'repos', ghostKey)
  assert.ok(!existsSync(ghostDir), 'precondition: the ghost store does not exist')

  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'])

  // The load-bearing assertion: the read path must not have brought it into
  // being. `registry.get` cannot; `registry.open` would have.
  assert.ok(
    !existsSync(ghostDir),
    `the read path must never create a store — ${ghostDir} was conjured out of a declaration`,
  )
  assert.equal(
    s.registry.get(ghostKey),
    undefined,
    'and the registry must not hold one either',
  )
  const warned = s.warnings.find((w) => w.includes(ghost))
  assert.ok(warned, 'the missing store is reported')
  assert.ok(warned.includes(ghostKey), 'with the derived key, so a typo can be diagnosed')
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 14 --------

test('14. the fingerprint covers `archived`: flipping it does NOT reuse an existing approval', async () => {
  // The mutation this exists to kill: dropping `archived` from `canonicalize`.
  // The two declarations below would then fingerprint identically, so an
  // approval granted for "Backend, as a checkout in this workspace" would be
  // silently reused for "Backend, as an ARCHIVED repository" — a member the
  // human was never warned about, admitted under a grant they gave for a
  // different claim, with no second prompt.
  //
  // `archived` is not cosmetic: it selects which admission rule applies and
  // which sentence the human reads. It is part of WHAT WAS APPROVED.
  const s = setup()
  const asWorktree = { version: 1, group: 'acme', members: [{ source: s.sources.backend, archived: false }] }
  const asArchived = { version: 1, group: 'acme', members: [{ source: s.sources.backend, archived: true }] }

  // The fingerprints must differ at the source — this is the mechanism itself.
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(asWorktree), 'utf8')
  const worktreePrint = readGroupDeclaration(s.ws, { warn() {}, info() {} }).fingerprint
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(asArchived), 'utf8')
  const archivedPrint = readGroupDeclaration(s.ws, { warn() {}, info() {} }).fingerprint
  assert.notEqual(
    worktreePrint,
    archivedPrint,
    'the same source claimed two different ways must fingerprint differently, or one ' +
      "human decision would authorise the other claim",
  )

  // And end to end, along the path that actually reaches a user: approve
  // Backend as a checkout in this workspace; later the checkout is gone (moved,
  // renamed, cleaned) and the declaration is edited to `archived: true`. That
  // second claim is the one the prompt warns about — "no checkout here, nothing
  // can verify this" — so it must be ASKED, not inherited from the first grant.
  // A member cannot be admitted both ways at once (the two rules are exclusive
  // by construction), so removing the checkout is what makes the second claim
  // admissible at all.
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(asWorktree), 'utf8')
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  const first = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.equal(s.asked.length, 1, 'the first claim was approved')
  assert.ok(
    first.hits.some((h) => h.title === 'backend deploy'),
    'and it really did admit the member, or the grant under test never existed',
  )
  assert.match(s.asked[0].reason, /checked out inside this workspace/)

  // The checkout disappears; the declaration now claims the archived form.
  rmSync(s.backend, { recursive: true, force: true })
  clearRepoIdentityMemo()
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(asArchived), 'utf8')
  const second = fakeAgent({ id: 'second', cwd: s.ws })
  const live = new Map([[s.principal.id, s.principal], [second.id, second]])
  s.service.ctx.agents.get = (id) => live.get(id)
  s.service.ctx.agents.list = () => [...live.values()]
  const after = await s.service.recall({ query: 'deploy' }, second)
  assert.equal(
    s.asked.length,
    2,
    'flipping `archived` is a NEW authorisation question and must be asked again — with ' +
      '`archived` outside the fingerprint the first grant would silently cover it',
  )
  assert.match(
    s.asked[1].reason,
    /ARCHIVED/,
    'and the second prompt is the one carrying the unverifiable-claim warning',
  )
  assert.ok(
    after.hits.some((h) => h.title === 'backend deploy'),
    'the second claim was separately approved, so the member participates under ITS OWN grant',
  )
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 15 --------

test('15. a `.git` FILE pointing outside the workspace does not count as a checkout here', async () => {
  // `.git` is a directory in an ordinary clone and a FILE (`gitdir: <path>`) in
  // a worktree/submodule checkout. That file is committed content, so it is
  // attacker-controlled in exactly the way `.strataloom-group.json` is — and
  // both arrive together in a single `git clone`.
  //
  // The attack: point `.git` at a gitdir OUTSIDE the workspace. `git rev-parse
  // --show-toplevel` still truthfully reports a path inside the workspace, so
  // the repository passes admission rule (a) as a worktree member and the
  // approval prompt calls a private repository living elsewhere "(checked out
  // inside this workspace)" — the ARCHIVED warning never appears.
  const s = setup()
  // A real repository whose gitdir lives OUTSIDE the workspace.
  const foreign = makeRepo(join(tempRoot(), 'planted'), 'git@github.com:acme/Planted.git')
  const plantedSource = sourceFor('git@github.com:acme/Planted.git')

  // Inside the workspace: a directory whose `.git` is a FILE redirecting to it.
  const bait = join(s.ws, 'Bait')
  mkdirSync(bait, { recursive: true })
  writeFileSync(join(bait, '.git'), `gitdir: ${join(foreign, '.git')}\n`, 'utf8')
  clearRepoIdentityMemo()

  const found = worktreeSources(s.ws)
  assert.ok(
    !found.has(plantedSource),
    'a `.git` file resolving outside the workspace must NOT be counted as a checkout inside it',
  )

  // And end to end: declared without `archived`, it must be refused by rule (a)
  // rather than admitted and mislabelled to the human.
  const s2 = setup({ approval: 'rejected' })
  const bait2 = join(s2.ws, 'Bait')
  mkdirSync(bait2, { recursive: true })
  writeFileSync(join(bait2, '.git'), `gitdir: ${join(foreign, '.git')}\n`, 'utf8')
  clearRepoIdentityMemo()
  s2.registry.open(repoKeyFor(plantedSource), plantedSource)
  writeFileSync(
    join(s2.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [plantedSource] }),
    'utf8',
  )
  seed(s2.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  const hits = await s2.service.recall({ query: 'deploy' }, s2.principal)
  assert.deepEqual(hits.hits.map((h) => h.title), ['parent deploy'])
  assert.equal(
    s2.asked.length,
    0,
    'the planted repository is refused by rule (a), not surfaced as a workspace checkout',
  )
  s2.registry.dispose()
  cleanup(s2.root)
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 16 --------

test('16. member sources are normalized: a `.git` suffix is not a different repository', async () => {
  // Not a security hole — the failure direction is "reads nothing" — but a
  // usability one that looks exactly like a broken feature. A declaration is
  // written by hand while `deriveRepoIdentity` normalizes its own source, so
  // six plausible spellings of one remote produced six distinct keys, each
  // skipped with "no store on disk".
  const s = setup()
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])

  // The single most common error: the `.git` suffix people copy from a clone URL.
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({ version: 1, group: 'acme', members: [`${s.sources.backend}.git`] }),
    'utf8',
  )
  const hits = await s.service.recall({ query: 'deploy' }, s.principal)
  assert.deepEqual(
    hits.hits.map((h) => h.title),
    ['parent deploy', 'backend deploy'],
    'a `.git` suffix names the same repository and must resolve to the same store',
  )

  // The spellings that must all collapse to one key.
  for (const spelling of [
    `${s.sources.backend}.git`,
    `${s.sources.backend}/`,
    'remote:GitHub.com/acme/Backend',
  ]) {
    assert.equal(
      repoKeyFor(spelling),
      repoKeyFor(s.sources.backend),
      `"${spelling}" must derive the same store key as "${s.sources.backend}"`,
    )
  }
  s.registry.dispose()
  cleanup(s.root)
})

// --------------------------------------------------------------- 17 --------

test('17. NOTHING IS WRITTEN to a member store on any read path — the approval prompt says so', async () => {
  // The blocker this exists for: `recall` called `touchUsage(member.store, …)`,
  // so every approved read ran `INSERT INTO usage … ON CONFLICT DO UPDATE` in
  // a repository this session may only READ. The approval prompt — the one
  // load-bearing gate, because the `archived` predicate verifies almost
  // nothing — told the human "Nothing is ever written to them" while that
  // happened. The whole suite was green: no case looked at a foreign store's
  // bytes after a read.
  //
  // So the assertion is not "we did not call touchUsage" (unobservable, and it
  // would re-encode the implementation). It is the promise itself, measured the
  // way a person would check it: the FILE must not change.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({
      version: 1,
      group: 'acme',
      members: [s.sources.backend, s.sources.frontend, { source: s.sources.archived, archived: true }],
    }),
    'utf8',
  )
  seed(s.stores.parent, [{ title: 'parent deploy', body: 'p' }])
  const [backendId] = seed(s.stores.backend, [{ title: 'backend deploy', body: 'b' }])
  seed(s.stores.frontend, [{ title: 'frontend deploy', body: 'f' }])
  const [archivedId] = seed(s.stores.archived, [{ title: 'archived deploy', body: 'a' }])
  // Evidence + a stored turn, so `source` has something real to drill into on
  // the foreign side and is exercised rather than short-circuited.
  s.stores.backend.db
    .prepare(`INSERT INTO evidence (memory_id, kind, ref) VALUES (?, 'session', 'sess-b')`)
    .run(backendId)
  s.stores.backend.db
    .prepare(
      `INSERT INTO conversations (session_id, seq, turn, label, provenance, text, created_at)
       VALUES ('sess-b', 1, 1, 'user', 'human', 'the original words', 0)`,
    )
    .run()

  // Checkpoint every member store on disk. WAL means the visible bytes can sit
  // in `-wal` rather than the main file, so the digest is taken after a
  // TRUNCATE checkpoint — otherwise a write could hide in an unread file and
  // this case would pass for the wrong reason.
  const memberFiles = {
    backend: join(s.root, 'repos', repoKeyFor(s.sources.backend), 'memory.sqlite'),
    frontend: join(s.root, 'repos', repoKeyFor(s.sources.frontend), 'memory.sqlite'),
    archived: join(s.root, 'repos', repoKeyFor(s.sources.archived), 'memory.sqlite'),
  }
  const digest = () => {
    const out = {}
    for (const [name, file] of Object.entries(memberFiles)) {
      s.stores[name].db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      out[name] = createHash('md5').update(readFileSync(file)).digest('hex')
    }
    return out
  }
  // A usage snapshot too: it is the table that was actually being written, and
  // a digest alone would not say WHAT changed when this fails.
  const usage = () => {
    const out = {}
    for (const name of Object.keys(memberFiles)) {
      out[name] = s.stores[name].db
        .prepare(`SELECT memory_id, retrieved, last_hit_at FROM usage ORDER BY memory_id`)
        .all()
    }
    return out
  }

  const beforeDigest = digest()
  const beforeUsage = usage()

  // Every read exit that can reach a member store, several times over, so a
  // counter increment has every chance to appear.
  for (let round = 0; round < 3; round++) {
    const hits = await s.service.recall({ query: 'deploy' }, s.principal)
    assert.ok(
      hits.hits.some((h) => h.id === backendId),
      'the member really was read — otherwise nothing below is tested',
    )
    await s.service.list(s.principal, 200)
    const turns = await s.service.source(backendId, s.principal, 10)
    assert.equal(turns[0].text, 'the original words', 'the foreign drill-down really ran')
    await assert.rejects(s.service.forget(archivedId, s.principal), /cannot be removed/)
  }

  const afterDigest = digest()
  const afterUsage = usage()

  for (const name of Object.keys(memberFiles)) {
    assert.equal(
      afterDigest[name],
      beforeDigest[name],
      `${name}: the approval prompt promises "Nothing is ever written to them", and this ` +
        `session changed the bytes of ${memberFiles[name]}. Either stop writing, or change ` +
        'the sentence a human approved on and ask them again.',
    )
    assert.deepEqual(
      afterUsage[name],
      beforeUsage[name],
      `${name}: usage rows moved. They are not "non-authoritative" across a repository ` +
        'boundary — pipeline/decay.ts turns usage.last_hit_at into memories.status.',
    )
  }

  // And the promise is actually IN the prompt, in a form a person can act on:
  // an assertion about behaviour that never checks the sentence would let the
  // sentence be deleted and this case stay green.
  assert.equal(s.asked.length, 1)
  assert.match(
    s.asked[0].reason,
    /Nothing is ever written to them/,
    'the prompt must still make the promise this case verifies',
  )
  assert.match(
    s.asked[0].reason,
    /marked as used/,
    'and must be specific enough to cover the usage counter, which is the write that was ' +
      'defended for months as "not really a write"',
  )
  s.registry.dispose()
  cleanup(s.root)
})

test('17b. D4 ACROSS REPOSITORIES: a pure read here does not change memories.status there', async () => {
  // The deeper half of the same defect, and the reason "usage is
  // non-authoritative" was not a defence. `pipeline/decay.ts` states the
  // invariant in its own module comment — "revival happens HERE, never on the
  // read path, because a read must not cause an authoritative change (D4)" —
  // and it reads `usage.last_hit_at` to decide `memories.status`. Inside one
  // repository that chain is contained. Across repositories it means a recall
  // in THIS session rewrote authoritative state in ANOTHER repository.
  //
  // Measured on copies of the real stores before the fix: a Backend store
  // staged to 61 stale active rows slept all 61 when it decayed alone, and only
  // 57 after a FullStack session ran 7 pure recalls — 4 rows kept `active` in
  // another repository by a read in this one.
  //
  // So this is a CONTROL vs EXPERIMENT case, not an equality: the same store,
  // the same decay, differing only in whether this session read first. Anything
  // less could not distinguish "decay did nothing" from "the read had no
  // effect".
  const stage = (store, now) => {
    // Past DECAY_MIN_ACTIVE, all stale, so every row is a sleep candidate and
    // the floor is genuinely cleared. Below the floor decay is a no-op and the
    // comparison would be vacuous.
    const stale = now - DECAY_IDLE_MS - 86_400_000
    const rows = Array.from({ length: DECAY_MIN_ACTIVE + 11 }, (_, i) => ({
      title: `foreign deploy topic ${i}`,
      body: 'f',
    }))
    const ids = seed(store, rows)
    store.db.prepare(`UPDATE memories SET updated_at = ?`).run(stale)
    return ids
  }
  const decayOnce = (store, now) => {
    enqueueJob(store, 'decay', jobId('decay', store.repoKey, String(now)), {}, now)
    const job = claimNextJob(store, now, now + 300_000)
    assert.ok(job, 'the decay job was claimed')
    return runDecayJob(store, job, now)
  }
  const activeCount = (store) =>
    store.db.prepare(`SELECT count(*) n FROM memories WHERE status='active' AND derived=0`).get().n

  const now = Date.now()

  // CONTROL: the member repository decays on its own; this session never runs.
  const control = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(control.ws, GROUP_FILE), JSON.stringify(GROUP_OF(control.sources)), 'utf8')
  stage(control.stores.backend, now)
  const controlBefore = activeCount(control.stores.backend)
  decayOnce(control.stores.backend, now)
  const controlAfter = activeCount(control.stores.backend)
  control.registry.dispose()
  cleanup(control.root)

  // EXPERIMENT: identical staging, but this session performs pure reads first.
  const exp = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(exp.ws, GROUP_FILE), JSON.stringify(GROUP_OF(exp.sources)), 'utf8')
  stage(exp.stores.backend, now)
  const expBefore = activeCount(exp.stores.backend)
  const read = await exp.service.recall({ query: 'deploy' }, exp.principal)
  assert.ok(
    read.hits.some((h) => h.id.startsWith(exp.stores.backend.repoKey.slice(0, 8))),
    'the session really did read foreign rows — otherwise this proves nothing',
  )
  decayOnce(exp.stores.backend, now)
  const expAfter = activeCount(exp.stores.backend)

  assert.equal(controlBefore, expBefore, 'both arms started from the same store state')
  assert.equal(
    expAfter,
    controlAfter,
    `a pure read in this session changed how many memories stayed active in ANOTHER ` +
      `repository (${expAfter} vs ${controlAfter} with no read at all). That is a read ` +
      'causing an authoritative change across a repository boundary — the exact thing D4 ' +
      'forbids and pipeline/decay.ts claims cannot happen.',
  )
  exp.registry.dispose()
  cleanup(exp.root)
})

// --------------------------------------------------------------- 18 --------

test('18. ATTRIBUTION: a foreign entry says which repository it came from, and the header stops claiming "this repository"', async () => {
  // The blocker this exists for: `FRAMING_HEADER` says the entries are "from
  // previous sessions in this repository", `MemoryHit` carried no origin, and
  // the output schema was `additionalProperties: false` — so there was nowhere
  // for an origin to go even if one had been computed. Measured over 2792
  // queries against the real stores, 1508 (54.0%) returned results that were
  // 100% foreign, delivered under that sentence: deployment facts owned by an
  // archived operations repo with no checkout on this machine, build rules
  // owned by the frontend repo, all presented as this repository's own.
  //
  // `/memory` list had already solved exactly this (MemoryListingScope carries
  // `source`, and its comment says "complete but unattributable is not
  // complete"). This is that rule reaching the other read exit.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(join(s.ws, GROUP_FILE), JSON.stringify(GROUP_OF(s.sources)), 'utf8')
  seed(s.stores.parent, [{ title: 'parent deploy rule', body: 'p' }])
  seed(s.stores.backend, [{ title: 'backend deploy rule', body: 'b' }])
  seed(s.stores.frontend, [{ title: 'frontend deploy rule', body: 'f' }])

  const hits = (await s.service.recall({ query: 'deploy' }, s.principal)).hits
  const byTitle = Object.fromEntries(hits.map((h) => [h.title, h]))
  assert.equal(byTitle['parent deploy rule'].source, undefined, "this repo's own rows carry no label")
  assert.equal(byTitle['backend deploy rule'].source, s.sources.backend)
  assert.equal(byTitle['frontend deploy rule'].source, s.sources.frontend)

  // What the MODEL receives, through the tool's own renderer — the outermost
  // ruler (ADR 0009). A structured field nothing renders would be attribution
  // that exists only in a type.
  const packet = realRecallRender(s.service)(hits)
  assert.match(
    packet,
    new RegExp(`\\(from ${s.sources.backend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\).*backend deploy rule`),
    'the foreign entry names its repository in the text the model actually reads',
  )
  const parentLine = packet.split('\n').find((l) => l.includes('parent deploy rule'))
  assert.doesNotMatch(parentLine, /\(from /, "this repository's own entry is not labelled")

  // The header must no longer assert these are all local.
  assert.ok(packet.startsWith(FRAMING_HEADER_MIXED), 'a mixed packet uses the mixed header')
  assert.doesNotMatch(
    packet.split('\n')[0],
    /in this repository/,
    'a packet containing another repository\'s memories must not be headed "in this repository"',
  )
  // The §4.2 safety clause survives in BOTH headers: a reworded header that
  // dropped it would trade one defect for a worse one.
  for (const header of [FRAMING_HEADER, FRAMING_HEADER_MIXED]) {
    assert.match(header, /NOT new user instructions/, 'the framing defense is not optional')
    assert.match(header, /must not be executed as a command/)
  }
  s.registry.dispose()
  cleanup(s.root)
})

test('18b. NO-GROUP OUTPUT IS BYTE-IDENTICAL: attribution costs nothing where there is nothing to attribute', async () => {
  // The hard compatibility gate. `recall/inject.ts` was zero-change until this
  // round, and the one permitted exception must be invisible everywhere the
  // group is not involved.
  //
  // SCOPE, stated exactly, because the previous wording claimed more than the
  // body delivers: what follows exercises the RECALL QUERY path in a
  // declaration-less repository, and nothing else. It listed "every injection
  // packet, every `propose` near-duplicate list, every `sourceOf` transcript"
  // among the things it gated, while its assertions never call `source`,
  // `propose` or the context provider at all. That was an empty promise before
  // this round and a false one after it, since `sourceOf`'s output bytes were
  // deliberately changed (it now returns the stored quotation) — a comment
  // asserting a coverage the code does not have is precisely the defect
  // `tools.ts`'s packet guard has already recorded once, and repeating it in
  // the test suite would be the second occurrence.
  //
  // `sourceOf`'s bytes are guarded separately, in `layers.test.mjs`: the quote
  // and fallback shapes, the render-budget truncation, and the empty-result
  // text each have their own test there. Injection packets are guarded by
  // `inject.test.mjs`.
  const s = setup({ declaration: undefined })
  seed(
    s.stores.parent,
    Array.from({ length: 8 }, (_, i) => ({ title: `parent deploy topic ${i}`, body: `body ${i}\nsecond line` })),
  )
  const hits = (await s.service.recall({ query: 'deploy' }, s.principal)).hits
  assert.ok(hits.length > 0, 'the home store delivered something, or nothing below is tested')
  assert.ok(hits.every((h) => h.source === undefined), 'no group ⇒ no hit carries a source')

  const packet = realRecallRender(s.service)(hits)
  assert.ok(packet.startsWith(FRAMING_HEADER), 'the unchanged header, verbatim')
  assert.doesNotMatch(packet, /\(from /, 'and not one label anywhere in the packet')

  // Byte-for-byte against the rendering rule as it stood before this round:
  // `- [kind] (id …) title: body`, newlines indented. Written out literally
  // rather than by calling `renderEntry`, because calling the function under
  // test to describe what it should produce asserts only that it equals itself.
  const expected = [
    FRAMING_HEADER,
    '',
    ...hits.map(
      (h) => `- [${h.kind}] (id ${h.id}) ${h.title}: ${h.body}`.replaceAll('\n', '\n  '),
    ),
  ].join('\n')
  assert.equal(
    packet,
    expected,
    'a packet with no foreign entry must render exactly as it did before attribution existed',
  )
  s.registry.dispose()
  cleanup(s.root)
})

test('18c. the label is inside the BUDGET, not added after it — the packet cannot exceed its container', async () => {
  // The D8 failure this forecloses: attach `source` AFTER `withinBudget` and
  // every admitted foreign row silently grows by up to
  // SOURCE_LABEL_MAX_CHARS + 8 characters past what the budget was told it
  // costs. The service would then admit rows the guard priced smaller, and the
  // 8192-character container the guard defends could be exceeded in production
  // while every arithmetic assertion stayed green.
  const s = setup({ declaration: GROUP_OF({ backend: '', frontend: '' }) })
  writeFileSync(
    join(s.ws, GROUP_FILE),
    JSON.stringify({
      version: 1,
      group: 'acme',
      members: [s.sources.backend, s.sources.frontend, { source: s.sources.archived, archived: true }],
    }),
    'utf8',
  )
  // SMALL foreign bodies, and that is what makes this case bind rather than
  // pass by luck. The label costs a fixed ~9 tokens PER ROW, so the error only
  // becomes visible when many rows are admitted and it accumulates. Seeded at
  // 200 characters each, only one row per member fits the budget at all, the
  // single row's overshoot stays inside the slack, and the defect is invisible
  // — measured: the mutation "attach `source` after `withinBudget`" survived
  // this case verbatim in that shape. At 30 characters roughly 7-10 rows are
  // admitted, the accumulated label cost is ~90 tokens, and no arrangement of
  // the budget can hide it.
  seed(
    s.stores.parent,
    Array.from({ length: 30 }, (_, i) => ({ title: `parent deploy topic ${i}`, body: 'p'.repeat(200) })),
  )
  for (const store of [s.stores.backend, s.stores.frontend, s.stores.archived]) {
    seed(
      store,
      Array.from({ length: 40 }, (_, i) => ({
        title: `foreign deploy topic ${i}`,
        body: 'f'.repeat(30),
      })),
    )
  }
  const hits = (await s.service.recall({ query: 'deploy' }, s.principal)).hits
  const foreign = hits.filter((h) => h.source !== undefined)
  assert.ok(foreign.length > 0, 'foreign rows were delivered, or the budget under test is unspent')

  // Each member's delivered rows, priced AS RENDERED (label included), must fit
  // that member's own budget.
  for (const source of new Set(foreign.map((h) => h.source))) {
    const mine = foreign.filter((h) => h.source === source)
    const cost = mine.reduce((sum, h) => sum + estimateTokens(renderEntry(h, true)), 0)
    assert.ok(
      cost <= RECALL_FOREIGN_BUDGET_TOKENS,
      `${source} delivered ${cost} tokens as rendered, past its ${RECALL_FOREIGN_BUDGET_TOKENS} ` +
        'budget — the source label was not priced when the rows were selected',
    )
  }
  const packet = realRecallRender(s.service)(hits)
  assert.ok(
    packet.length <= RECALL_PACKET_MAX_CHARS,
    `the rendered packet is ${packet.length} chars, past the ${RECALL_PACKET_MAX_CHARS} ` +
      'tool-result container the platform pruner would cut the middle out of',
  )
  s.registry.dispose()
  cleanup(s.root)
})

test('18d. the recall tool SCHEMA admits `source`, so an attributed hit is not rejected on the way out', async () => {
  // `additionalProperties: false` is enforced against the returned value by
  // the tool runtime. If the service attaches `source` and the schema does not
  // declare it, the tool call FAILS — attribution would take the whole read
  // exit down rather than degrade. This asserts the schema and the service
  // agree, which no test above does: they all call the service directly.
  let captured
  registerTools({ tools: { register: (tool) => { if (tool.name === 'memory_recall') captured = tool } } }, {})
  assert.ok(captured, 'memory_recall was registered')
  const properties = captured.output.schema.properties.hits.items.properties
  assert.ok(properties.source, 'the recall hit schema must declare `source`')
  assert.equal(captured.output.schema.properties.hits.items.additionalProperties, false)
  // And it must be OPTIONAL: home rows omit it, and a required field would
  // fail every non-group result — i.e. almost every result.
  assert.notEqual(properties.source.required, true, '`source` must be optional, not required')
  // The real validator, on a real mixed value, is the only thing that proves
  // the two ends actually agree.
  const violations = validateJsonSchemaValue(captured.output.schema, {
    hits: [
      { id: 'a', kind: 'fact', title: 't', body: 'b' },
      { id: 'c', kind: 'fact', title: 't', body: 'b', source: 'remote:github.com/acme/Backend' },
    ],
  })
  assert.deepEqual(violations, [], 'a mixed home/foreign result must pass the output schema')
})
