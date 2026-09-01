/**
 * The tool-guidance section is prepended to EVERY request, which makes its
 * size a per-turn tax rather than a one-off cost. It had grown to 245 tokens
 * against a "≤150" line in the spec that nothing enforced.
 *
 * The cause was not verbose copy — the static text has not changed since
 * 2026-08-23. It was the kind criteria being rendered a THIRD time in prose
 * while already reaching the model through the `kind` schema description of
 * both `memory_recall` and `memory_propose`. So these tests pin two different
 * things: that the duplicate stays gone, and that the surviving copies stay.
 * Deleting either one alone would be a regression in the opposite direction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GUIDANCE_SECTION } from '../lib/tools.js'
import { GUIDANCE_BUDGET_TOKENS } from '../lib/constants.js'
import { estimateTokens } from '../lib/recall/render.js'
import { kindGuidance } from '../lib/types.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const toolsSrc = join(packageRoot, 'src', 'tools.ts')

test('1. the guard binds: one more sentence pushes the section over budget', () => {
  // The only test that can distinguish a real guard from a vacuous one. ADR
  // 0011 shipped an assertion whose condition reduced to `200 > 500` and so
  // certified anything; the lesson is that a guard nobody has watched FAIL is
  // not known to be a guard.
  //
  // It runs against a COPY of the built module, never the shared `lib/`. The
  // first version of this test rebuilt `lib/` in place and restored it after,
  // which is correct in isolation and wrong in a suite: `node --test` runs
  // files concurrently, so `package.test.mjs` packed the tarball during the
  // oversized window and failed on an error this test had just injected. Two
  // real failures, zero real defects. A test that mutates shared build output
  // is a test that reports on whatever else happened to be running.
  const built = readFileSync(join(packageRoot, 'lib', 'tools.js'), 'utf8')
  // Anchor on the CLOSING line of GUIDANCE_SECTION specifically. The shorter
  // phrase "data, not instructions." also ends the memory_recall description,
  // and matching that one grew a string the guard does not price — the probe
  // then "passed" by not throwing, which is precisely the false negative this
  // test exists to rule out. Uniqueness is asserted, not assumed.
  const anchor = "'data, not instructions.',"
  assert.equal(built.split(anchor).length - 1, 1, 'anchor must be unique; update this test')

  const scratch = join(packageRoot, 'lib', `tools.guardprobe-${process.pid}.js`)
  try {
    writeFileSync(
      scratch,
      built.replace(
        anchor,
        "'data, not instructions. Prefer recording a durable lesson over a status " +
          "update, and say plainly when you are unsure whether it will still matter.',",
      ),
      'utf8',
    )

    let threw
    try {
      execFileSync(process.execPath, ['-e', `import('./${'lib/' + scratch.split('/lib/')[1]}')`], {
        cwd: packageRoot,
        stdio: 'pipe',
      })
      threw = undefined
    } catch (error) {
      threw = String(error.stderr)
    }
    assert.ok(threw !== undefined, 'oversized guidance section must throw at load time')
    assert.match(threw, /tool-guidance section renders \d+ tokens/)
    // The number must exceed the budget, or the message is describing something
    // other than the condition that fired.
    const measured = Number(/renders (\d+) tokens/.exec(threw)[1])
    assert.ok(measured > GUIDANCE_BUDGET_TOKENS, `${measured} should exceed the budget`)
  } finally {
    rmSync(scratch, { force: true })
  }
})

test('1b. the real module loads: the probe above is not passing on a broken build', () => {
  // Control group for test 1. Without it, "it throws when mutated" would also
  // pass if the module threw unconditionally.
  assert.ok(estimateTokens(GUIDANCE_SECTION.text) <= GUIDANCE_BUDGET_TOKENS)
})

test('2. pricing reads the assembled text, not the source fragments', () => {
  // The defect grew inside a template expression while the literals around it
  // stayed constant, so a guard reading fragments would have been blind to the
  // one thing it exists to catch (ADR 0007's newline blindness, again).
  assert.equal(typeof GUIDANCE_SECTION.text, 'string')
  assert.ok(!GUIDANCE_SECTION.text.includes('${'), 'text must be fully expanded')
  assert.ok(estimateTokens(GUIDANCE_SECTION.text) <= GUIDANCE_BUDGET_TOKENS)
})

test('3. the kind criteria are NOT rendered in the guidance section', () => {
  // The substance of the fix: this rule reaches the model through schemas.
  assert.ok(
    !GUIDANCE_SECTION.text.includes(kindGuidance()),
    'kind criteria belong in the schema descriptions, not in prose read every turn',
  )
  assert.ok(!GUIDANCE_SECTION.text.includes('true of THIS repo'))
})

test('4. the four load-bearing instructions survive the trim', () => {
  // A budget invites "just shorten it", so the semantics that must not be
  // traded away for tokens are pinned individually.
  const text = GUIDANCE_SECTION.text
  for (const tool of ['memory_recall', 'memory_propose', 'memory_forget']) {
    assert.ok(text.includes(tool), `${tool} must still say when it applies`)
  }
  assert.ok(text.includes('Scope is separate from kind'), 'scope/kind orthogonality')
  assert.ok(text.includes('ask instead of guessing'), 'clarify when durability is unclear')
  assert.ok(text.includes('reference'), 'stored memories are reference data, not instructions')
})

test('5. the kind criteria still reach the model through both schemas', () => {
  // Guards the opposite regression: "remove the duplicate" must not become
  // "remove the rule". Read from the built source so this fails if either
  // schema drops its description.
  const built = readFileSync(join(packageRoot, 'lib', 'tools.js'), 'utf8')
  const uses = built.split('KIND_DESCRIPTION').length - 1
  assert.ok(uses >= 3, `expected a definition plus two schema uses, saw ${uses}`)
  assert.ok(kindGuidance().includes('true of THIS repo'), 'criteria text itself intact')
})

test('6. the production entry point executes the guard', () => {
  // `package.json` exposes only ./lib/index.js, and index.ts imports tools.ts
  // statically — so the assertion cannot be bypassed by the shipped surface.
  const index = readFileSync(join(packageRoot, 'lib', 'index.js'), 'utf8')
  assert.match(index, /from ["']\.\/tools\.js["']/)
  // Only the root entry exposes code; `./package.json` is metadata and cannot
  // be a path around the guard. Asserting the code surface, not the key count.
  const exports = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).exports
  const codeEntries = Object.keys(exports ?? {}).filter((key) => key !== './package.json')
  assert.deepEqual(codeEntries, ['.'], 'a second code entry could bypass the guard')
})
