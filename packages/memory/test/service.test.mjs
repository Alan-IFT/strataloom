/** §10 closed-loop, API boundary, and forget domains. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryService, MemoryAccessError, MemoryInputError } from '../lib/service.js'
import { clearRepoIdentityMemo } from '../lib/store/repo-key.js'
import { DERIVED_PROVENANCE, INJECTABLE_PROVENANCE, LAYER } from '../lib/types.js'
import { openRegistry, cleanup, fakeAgent, fakeCtx, tempRoot } from './helpers.mjs'

/** A real git repo (repo-key derivation shells out to git — D1 fact source). */
const makeRepo = () => {
  const dir = join(tempRoot(), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const setup = () => {
  clearRepoIdentityMemo()
  const repo = makeRepo()
  const { root, registry } = openRegistry()
  const principal = fakeAgent({ id: 'principal', cwd: repo })
  const ctx = fakeCtx({ agents: [principal] })
  const service = Reflect.construct(function () {}, [])
  // Bypass cordis Service registration: construct via prototype so tests
  // need no cordis root. The class only uses this.ctx + this.stores.
  Object.setPrototypeOf(service, MemoryService.prototype)
  service.ctx = ctx
  service.stores = registry
  return { repo, root, registry, principal, ctx, service }
}

test('closed loop: propose -> active -> recall -> forget, all synchronous', async () => {
  const { root, registry, principal, service } = setup()
  const { id } = await service.propose(
    { title: 'use pnpm not npm', body: 'this repo uses pnpm for everything', kind: 'fact' },
    principal,
  )
  // active immediately; recall finds it
  const found = await service.recall({ query: 'pnpm' }, principal)
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].id, id)

  // evidence row written in the same transaction (D3)
  const store = service.storeFor(principal, false)
  const evidence = store.db
    .prepare(`SELECT kind, ref FROM evidence WHERE memory_id = ?`)
    .all(id)
    .map((row) => ({ ...row }))
  assert.deepEqual(evidence, [{ kind: 'session', ref: 'principal' }])

  const report = await service.forget(id, principal)
  assert.equal(report.suppressedRefs, 1)
  assert.match(report.note, /not.*erased|outside this capability/i)

  // read surface closed at commit
  const after = await service.recall({ query: 'pnpm' }, principal)
  assert.equal(after.hits.length, 0)
  // title/body cleared, ref kept
  const row = store.db.prepare(`SELECT title, body, status FROM memories WHERE id = ?`).get(id)
  assert.deepEqual({ ...row }, { title: '', body: '', status: 'tombstone' })
  assert.equal(store.db.prepare(`SELECT count(*) c FROM evidence WHERE memory_id = ?`).get(id).c, 1)
  registry.dispose()
  cleanup(root)
})

test('forge rejection: an agent object not in the registry is refused', async () => {
  const { root, registry, principal, service } = setup()
  const forged = { ...principal } // same id, different object identity
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, forged),
    MemoryAccessError,
  )
  registry.dispose()
  cleanup(root)
})

test('lineage predicate: subagent-origin and resumed-depth agents are refused writes', async () => {
  const { root, registry, service, ctx, repo } = setup()
  const subagent = fakeAgent({ id: 'sub', cwd: repo, origin: 'subagent', delegationDepth: 1, parentSession: 'principal' })
  const resumedFormerSub = fakeAgent({ id: 'resumed', cwd: repo, delegationDepth: 1 }) // runtime root, durable depth
  const runtimeDeep = fakeAgent({ id: 'deep', cwd: repo, runtimeDepth: 2 }) // header clean, runtime depth
  for (const agent of [subagent, resumedFormerSub, runtimeDeep]) {
    ctx.agents.get(agent.id) // ensure map lookup path
  }
  // register them as live
  const live = fakeCtx({ agents: [subagent, resumedFormerSub, runtimeDeep] })
  service.ctx = live
  await assert.rejects(service.propose({ title: 't', body: 'b', kind: 'fact' }, subagent), /principal/)
  await assert.rejects(service.forget('x', resumedFormerSub), /principal/)
  await assert.rejects(service.propose({ title: 't', body: 'b', kind: 'fact' }, runtimeDeep), /principal/)
  registry.dispose()
  cleanup(root)
})

test('ordinary user fork (parentSession, no origin/depth) IS principal — misfire regression', async () => {
  const { root, registry, service, repo } = setup()
  const fork = fakeAgent({ id: 'fork', cwd: repo, parentSession: 'older-session' })
  service.ctx = fakeCtx({ agents: [fork] })
  const { id } = await service.propose({ title: 't', body: 'b', kind: 'fact' }, fork)
  assert.ok(id)
  registry.dispose()
  cleanup(root)
})

test('no cwd or non-git cwd: writes refused, recall empty (never process.cwd())', async () => {
  const { root, registry, service } = setup()
  const nowhere = fakeAgent({ id: 'nowhere' }) // no cwd
  const outside = fakeAgent({ id: 'outside', cwd: tempRoot() }) // not a git tree
  service.ctx = fakeCtx({ agents: [nowhere, outside] })
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, nowhere),
    /no repo affiliation/,
  )
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'fact' }, outside),
    /no repo affiliation/,
  )
  const result = await service.recall({ query: 'anything' }, nowhere)
  assert.deepEqual(result.hits, [])
  registry.dispose()
  cleanup(root)
})

test('candidate carries no visibility/provenance: unknown kinds and oversizes fail loud', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(
    service.propose({ title: 't', body: 'b', kind: 'visibility-smuggle' }, principal),
    MemoryInputError,
  )
  await assert.rejects(
    service.propose({ title: 'x'.repeat(300), body: 'b', kind: 'fact' }, principal),
    MemoryInputError,
  )
  registry.dispose()
  cleanup(root)
})

test('forget unknown/already-forgotten ids fail loud; usage table updates on recall', async () => {
  const { root, registry, principal, service } = setup()
  await assert.rejects(service.forget('ghost', principal), MemoryInputError)
  const { id } = await service.propose({ title: 'k8s deploy steps', body: 'run make deploy', kind: 'procedure' }, principal)
  await service.recall({ query: 'deploy' }, principal)
  const store = service.storeFor(principal, false)
  const usage = store.db.prepare(`SELECT retrieved FROM usage WHERE memory_id = ?`).get(id)
  assert.equal(usage.retrieved, 1)
  await service.forget(id, principal)
  await assert.rejects(service.forget(id, principal), /already forgotten/)
  registry.dispose()
  cleanup(root)
})

/**
 * Newer than any `Date.now()` this suite will ever produce (year ~2255), and
 * that is the point rather than an arbitrary large number.
 *
 * `queryAllMemories` sorts `updated_at DESC` and then applies `LIMIT`, so the
 * OLDEST rows are the ones a limit drops. A derived row stamped with a small
 * timestamp therefore sits exactly where `LIMIT` would silently remove it, and
 * a leak would be masked by the cap instead of being caught: measured, with the
 * portrait at `updated_at = 9000` and the layer predicate widened, shrinking
 * this test's call to `list(principal, 1)` turned it GREEN. Stamped NEWEST, a
 * leaked portrait always lands at the head of the result, where no limit can
 * hide it — `LIMIT` can then only cut raw rows, which is the safe direction.
 */
const DERIVED_AT = 9_000_000_000_000

/**
 * The L3 portrait, in the shape `runPersonaJob` actually writes it: `private`
 * visibility (which `guard_visibility_insert` accepts in the global store and
 * only there), `derived` provenance (which the v10 column CHECK requires of
 * every non-raw row), and `LAYER.PERSONA`.
 */
const insertPortrait = (store, title) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES ('portrait-1', 'preference', 'private', 'active', ?, 'a generated portrait', ?, 0, ${DERIVED_AT}, ?)`,
    )
    .run(title, DERIVED_PROVENANCE, LAYER.PERSONA)

/**
 * An L2 scenario block in the shape `runRebuildJob` actually writes it into a
 * NON-global store — copied from `rebuild.ts`'s INSERT rather than invented:
 * `kind = 'fact'`, `visibility = 'repo-local'` (that file's own
 * `store.kind === 'global' ? 'private' : 'repo-local'`), `DERIVED_PROVENANCE`,
 * `status = 'active'`, and `LAYER.SCENARIO`.
 *
 * This is the layer a repo store actually accumulates. `rebuild.ts` writes
 * `LAYER.SCENARIO` for every store it rebuilds, so L2 is the normal resident of
 * a repo store the way L3 is of the global one — and the live install bears
 * that out: across nine readable stores the repo scope holds 19 active derived
 * rows in 4 stores against the global store's 1.
 */
const insertScenario = (store, id, title) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', 'repo-local', 'active', ?, 'a generated scenario block', ?, 0, ${DERIVED_AT}, ?)`,
    )
    .run(id, title, DERIVED_PROVENANCE, LAYER.SCENARIO)

/**
 * A raw row written straight to the store, so this domain can hold a
 * provenance `propose` never assigns. `propose` stamps `principal-explicit`,
 * which is INJECTABLE; the review surface's defining property is that it also
 * shows the rows the pipeline wrote unasked, and those are exactly the
 * non-injectable ones. Without such a row here, this listing would be equally
 * satisfied by `queryInjectableSet`'s predicate and could not tell the review
 * surface apart from the injection surface.
 */
const insertRawToolOutput = (store, id, title, at) =>
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, visibility, status, title, body, provenance, created_at, updated_at, derived)
       VALUES (?, 'fact', 'repo-local', 'active', ?, 'body', 'tool-output', 0, ?, ${LAYER.RAW})`,
    )
    .run(id, title, at)

/**
 * The THIRD `list()` call site, and the LAST one left unpinned. `list()` reads
 * `queryAllMemories` at three places — the repo store, the global store, and
 * once per group member — and this repo's own rule is that a rule with several
 * execution points needs a mutant per point. Two of the three were pinned (the
 * global one by the portrait case above, the member one by group 3b); this one
 * was not, and it was measurably unpinned: replacing THIS line alone with bare
 * SQL that keeps `status = 'active'` and drops the layer conjunct left the
 * whole suite at 270/270/0. No test in the suite asserted the CONTENT of a
 * repo-scope listing at all — `scope.kind` was only ever matched against
 * `'personal'` and `'group'`.
 *
 * Leaving it unpinned would have repeated the exact shape this round exists to
 * correct (v0.4.13's "four read surfaces, three guarded", v0.4.14's "five
 * statuses, one witness"), and it would have left the LARGEST surface open: the
 * repo scope carries 19 of the live install's 20 active derived rows, so the
 * pinned call site was the small one and the unpinned one the big one.
 */
test('list(): a repo-scope L2 scenario block never reaches the review surface', async () => {
  const { root, registry, principal, service } = setup()
  // Every RAW write first, without exception. D9's
  // `invalidate_derived_insert/update/delete` retire the entire derived layer
  // on any raw insert, update or delete, so a scenario block planted before
  // these would simply be gone and this case would assert over an empty layer.
  await service.propose(
    { title: 'this repo uses pnpm', body: 'never npm', kind: 'fact', scope: 'repo' },
    principal,
  )
  const repoStore = service.storeFor(principal, false)
  assert.ok(repoStore, 'the repo store is open, or there is no repo surface to test')
  insertRawToolOutput(repoStore, 'raw-pipeline', 'learned from a tool result', 3000)

  // The provenance axis, stated rather than trusted: if §2.3 ever widened the
  // injectable set to include `tool-output`, the row above would stop
  // discriminating and this case would go on passing while testing less.
  assert.ok(
    !INJECTABLE_PROVENANCE.includes('tool-output'),
    'tool-output must stay non-injectable, or this case no longer separates the ' +
      'review surface from the injection packet',
  )

  // Last write, and stamped NEWEST (`DERIVED_AT`) for the reason that constant
  // records: `ORDER BY updated_at DESC` + `LIMIT` drops the OLDEST rows, so an
  // excluded row given an old timestamp would sit exactly where the cap could
  // mask a leak. Newest, a leak always lands at the head of the result.
  insertScenario(repoStore, 'repo-scenario-1', 'deployment scenario rollup')

  // The premise, sampled at the moment the read happens rather than assumed.
  // Without it this case is inert in two directions: drop the scenario INSERT
  // and "only the raw rows come back" is vacuously true, or let a raw write
  // land after it and D9 has silently emptied the very layer under exclusion.
  assert.equal(
    repoStore.db.prepare(`SELECT count(*) AS n FROM memories WHERE derived != ${LAYER.RAW}`).get().n,
    1,
    'the L2 scenario block must REALLY be in the repo store when list() runs',
  )

  const listings = await service.list(principal, 200)
  const repoListing = listings.find((listing) => listing.scope.kind === 'repo')
  assert.ok(repoListing, 'the repo scope is listed')
  assert.deepEqual(
    repoListing.memories.map((memory) => memory.title).sort(),
    ['learned from a tool result', 'this repo uses pnpm'],
    'the repo listing shows its raw active rows — including the one written ' +
      'unasked by the pipeline, which is the point of a review surface — and not ' +
      'the generated scenario block, which summarizes the very rows beside it and ' +
      'which forget refuses outright',
  )
  // The consequence that makes the exclusion obligatory rather than tidy:
  // `command.ts` prints "Remove one with /memory forget <id>" under this list,
  // and this is what that instruction does to the row it would have offered.
  await assert.rejects(
    service.forget('repo-scenario-1', principal),
    /generated summary, not a stored memory/,
    'forget refuses the id the repo listing would have handed the user',
  )
  registry.dispose()
  cleanup(root)
})

/**
 * The reachable instance, through the WHOLE call chain rather than the query
 * alone. `queryAllMemories` has four consumers and the reconcile one is the
 * only one under test; `list()` accounts for three of the four, and it is
 * `list()` — not reconcile — that reads the global store where the portrait
 * lives. Reconcile's fixtures build L2 exclusively, so a mutant that blocks L2
 * and passes L1/L3 was invisible to the entire suite.
 *
 * Reproduced against a copy of the live global store before this test existed:
 * HEAD returned 22 rows with 0 derived, the widened predicate returned 23 with
 * the portrait among them.
 *
 * Why a leak is worse than one extra row: `command.ts` renders this listing and
 * prints "Remove one with /memory forget <id>", and `forget` refuses derived
 * ids outright ("a generated summary, not a stored memory"). The user is shown
 * a row that looks actionable and whose only offered action is guaranteed to
 * fail — so this asserts the refusal too, because it is the refusal that makes
 * the exclusion obligatory rather than merely tidy.
 */
test('list(): the L3 portrait in the global store never reaches the review surface', async () => {
  const { root, registry, principal, service } = setup()
  // A raw memory on each side, written BEFORE the portrait: D9 retires the
  // whole derived layer on any raw insert/update/delete, so a portrait planted
  // first would simply be gone and this test would assert over an empty layer.
  await service.propose(
    { title: 'this repo uses pnpm', body: 'never npm', kind: 'fact', scope: 'repo' },
    principal,
  )
  await service.propose(
    { title: 'speaks Chinese', body: 'reply in Chinese', kind: 'preference', scope: 'personal' },
    principal,
  )
  const personalStore = service.globalStore(false)
  assert.ok(personalStore, 'the global store is open, or there is no L3 surface to test')
  insertPortrait(personalStore, 'How to work with this user')

  // The premise, sampled immediately before the read — the same guard the
  // store-domain case uses. Without it, a `propose` that landed after the
  // portrait (D9) or a portrait the guards silently refused would leave this
  // test green while exercising nothing at all.
  assert.equal(
    personalStore.db
      .prepare(`SELECT count(*) AS n FROM memories WHERE derived != ${LAYER.RAW}`)
      .get().n,
    1,
    'the portrait must really be in the global store when list() runs',
  )

  const listings = await service.list(principal, 200)
  const personal = listings.find((listing) => listing.scope.kind === 'personal')
  assert.ok(personal, 'the personal scope is listed')
  assert.deepEqual(
    personal.memories.map((memory) => memory.title),
    ['speaks Chinese'],
    'the portrait is a regenerated summary of the rows already listed beside it — ' +
      'listing it double-counts, and offers a row forget cannot act on',
  )
  // The other half of the sentence, stated rather than assumed: the reason the
  // row must not be listed is that this is what happens if a user acts on it.
  await assert.rejects(
    service.forget('portrait-1', principal),
    /generated summary, not a stored memory/,
    'forget refuses the id list would have handed the user',
  )
  registry.dispose()
  cleanup(root)
})

test('recall matches phrases, not FTS syntax (server-side MATCH construction)', async () => {
  const { root, registry, principal, service } = setup()
  await service.propose({ title: 'quote "handling"', body: 'AND OR NOT are plain words here', kind: 'fact' }, principal)
  // Raw FTS operators as user input must not throw or change semantics.
  const result = await service.recall({ query: 'AND OR NOT' }, principal)
  assert.equal(result.hits.length, 1)
  const quoted = await service.recall({ query: 'quote "handling"' }, principal)
  assert.equal(quoted.hits.length, 1)
  registry.dispose()
  cleanup(root)
})
