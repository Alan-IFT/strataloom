/**
 * Repo groups: one workspace declares, by hand, which OTHER repositories'
 * memories this session may READ.
 *
 * The problem it exists for: a control-plane checkout can contain several
 * independent git repositories side by side (not submodules — separate
 * remotes, ignored by the parent). A session started at the parent legitimately
 * edits all of them, but `deriveRepoIdentity` gives each its own store, so what
 * was learned while changing the backend is invisible while changing the
 * frontend from the same session.
 *
 * ## What this module is NOT
 *
 * It is not discovery. The enumeration in `worktreeSources` exists ONLY to
 * VALIDATE that a declared member really is a checkout inside this workspace;
 * its result is never used to ADD members. A repository that is not written in
 * `members` does not participate, no matter how plainly it sits in the tree.
 * Auto-detecting nested `.git` directories was considered and REJECTED: it
 * makes "whose memories can this session read?" a property of whatever happens
 * to be on disk, which an attacker (or an unlucky `git clone`) controls. The
 * declaration is the whole authority; enumeration only refuses bad ones.
 *
 * Read this twice before "simplifying" the two into one pass. They look like
 * the same loop and they answer opposite questions.
 *
 * ## `archived` is a human assertion, not a verified fact
 *
 * A member marked `archived: true` is validated by only two checks: its store
 * exists on disk, and it is NOT a checkout in this workspace. Code CANNOT
 * verify the thing the word actually claims — that no checkout of it exists
 * anywhere on this machine — because that would mean scanning the whole
 * filesystem, and a checkout could appear a second later anyway.
 *
 * So the predicate here is deliberately weak, and it is not what makes this
 * safe. The load-bearing gate is HUMAN APPROVAL: the prompt lists every
 * archived member by name, because that is the only place where a person can
 * see "this group will read the memories of a repository that has no checkout
 * here" and say no. Do not read the predicate as a security boundary, and do
 * not add comments suggesting it verified anything.
 * @module @strataloom/dsh-memory/store/group
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, resolve, relative } from 'node:path'
import { deriveRepoIdentity, normalizeSource, repoKeyFor } from './repo-key.ts'
import type { OpenStore, StoreLogger, StoreRegistry } from './store.ts'
import { GROUP_MAX_MEMBERS } from '../constants.ts'

/** The declaration file, read from the session workspace root. */
export const GROUP_FILE = '.strataloom-group.json'

/**
 * Deliberately NOT under `.repo_memory/`. That directory is a pure OUTPUT
 * projection (ADR 0001): `projectStore` deletes and rewrites it, and with no
 * approved team-shareable row in any store on this machine it takes the
 * `rmSync` branch every time — a declaration placed there would be erased by
 * the next share. More fundamentally, ADR 0001 forbids anything in that
 * directory from becoming an INPUT, and this file is the most load-bearing
 * input the read path has.
 */

/** One declared member, after the string shorthand is expanded. */
export interface GroupMember {
  /** The `deriveRepoIdentity` source string, e.g. `remote:github.com/o/r`. */
  readonly source: string
  /** The human's assertion that this repo has no checkout here. Unverifiable. */
  readonly archived: boolean
}

/** A parsed declaration plus the fingerprint the approval was granted against. */
export interface GroupDeclaration {
  readonly group: string
  readonly members: readonly GroupMember[]
  /**
   * sha256 over the canonicalized member set. The approval is granted against
   * THIS value and the caller must keep using the very content that produced
   * it — re-reading the file after approval would reopen the TOCTOU window the
   * fingerprint exists to close (§2.1: validate inside the lock).
   */
  readonly fingerprint: string
}

/** Canonical member text: order-independent, so reordering is not a new group. */
const canonicalize = (members: readonly GroupMember[]): string =>
  [...members]
    .map((member) => `${member.archived ? 'archived' : 'worktree'}:${member.source}`)
    .sort()
    .join('\n')

const fingerprintOf = (members: readonly GroupMember[]): string =>
  createHash('sha256').update(canonicalize(members)).digest('hex').slice(0, 32)

/**
 * Read and validate the declaration. Every failure returns `undefined` AND
 * logs — fail open, never fail silent (spec §0): a malformed group file must
 * leave the session working exactly as it does today, but the user has to be
 * able to find out why their group did nothing.
 * @param workspaceRoot - the git toplevel of the session's own repository.
 * @param log - warning sink.
 */
export const readGroupDeclaration = (
  workspaceRoot: string,
  log: StoreLogger,
): GroupDeclaration | undefined => {
  const path = join(workspaceRoot, GROUP_FILE)
  // Absence is the overwhelmingly common case and is NOT a warning: almost no
  // repository is in a group, and a log line per session would be noise that
  // trains people to ignore the ones that matter.
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    log.warn(`strataloom: ${GROUP_FILE} is not valid JSON, ignoring it:`, error)
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) {
    log.warn(`strataloom: ${GROUP_FILE} must be a JSON object, ignoring it`)
    return undefined
  }
  const decl = raw as { version?: unknown; group?: unknown; members?: unknown }
  if (decl.version !== 1) {
    // An unknown version is refused rather than best-effort parsed: a future
    // format could give `members` a meaning that widens the read scope, and
    // guessing at it is exactly the wrong direction to guess in.
    log.warn(
      `strataloom: ${GROUP_FILE} has unsupported version ${JSON.stringify(decl.version)} ` +
        '(this build understands 1), ignoring it',
    )
    return undefined
  }
  if (!Array.isArray(decl.members)) {
    log.warn(`strataloom: ${GROUP_FILE} has no \`members\` array, ignoring it`)
    return undefined
  }
  if (decl.members.length > GROUP_MAX_MEMBERS) {
    log.warn(
      `strataloom: ${GROUP_FILE} declares ${decl.members.length} members, more than ` +
        `GROUP_MAX_MEMBERS (${GROUP_MAX_MEMBERS}); ignoring the whole declaration`,
    )
    return undefined
  }
  const members: GroupMember[] = []
  for (const entry of decl.members) {
    // The string shorthand is exactly `{ source, archived: false }` — one
    // meaning, two spellings, expanded here so nothing downstream has to know
    // there were ever two.
    // Sources are CANONICALIZED here, once, for both spellings. A declaration
    // is written by hand while `deriveRepoIdentity` writes its own source
    // through `normalizeRemoteUrl`, so `…/Backend.git`, `…/Backend/` and
    // `git@github.com:acme/Backend.git` are three spellings of one repository
    // that hashed to three different keys — each one skipped with "no store on
    // disk". Failing to find a store is the safe direction, but it is still a
    // feature that quietly does nothing for a plausible spelling.
    if (typeof entry === 'string') {
      if (entry === '') {
        log.warn(`strataloom: ${GROUP_FILE} has an empty member source, skipping it`)
        continue
      }
      members.push({ source: normalizeSource(entry), archived: false })
      continue
    }
    if (typeof entry !== 'object' || entry === null) {
      log.warn(`strataloom: ${GROUP_FILE} member ${JSON.stringify(entry)} is not a string or object, skipping it`)
      continue
    }
    const object = entry as { source?: unknown; archived?: unknown }
    if (typeof object.source !== 'string' || object.source === '') {
      log.warn(`strataloom: ${GROUP_FILE} member has no \`source\` string, skipping it`)
      continue
    }
    members.push({ source: normalizeSource(object.source), archived: object.archived === true })
  }
  const group = typeof decl.group === 'string' ? decl.group : '(unnamed)'
  return { group, members, fingerprint: fingerprintOf(members) }
}

/**
 * Directory names never descended into. Not a security measure — a group file
 * is trusted to the extent a human approved it — but a cost one: a dependency
 * tree can hold thousands of vendored checkouts, and this runs on a tool path.
 */
const PRUNE = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.next',
  '.cache',
])

/** Depth limit for the validation walk (the workspace root itself is depth 0). */
const MAX_DEPTH = 3

/** Whether `candidate` is `root` itself or genuinely beneath it, after symlinks. */
const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Whether the `.git` at `dir` really places this checkout INSIDE the workspace.
 *
 * `.git` is a DIRECTORY in an ordinary clone and a FILE containing
 * `gitdir: <path>` in a worktree or submodule checkout. That file is committed
 * content, so an attacker controls it in exactly the same way they control
 * `.strataloom-group.json` — and both arrive together in one `git clone`.
 *
 * The attack this refuses: point `.git` at a gitdir OUTSIDE the workspace.
 * `git rev-parse --show-toplevel` then truthfully reports a path inside the
 * workspace, so the repository passes admission rule (a) as a worktree member,
 * and the approval prompt describes a private repository living somewhere else
 * entirely as "(checked out inside this workspace)" — the ARCHIVED warning, the
 * one sentence a human can actually judge, never appears.
 *
 * So presence is not taken on the name alone: a `.git` file must resolve,
 * through `realpath`, to a gitdir inside the workspace. A symlinked `.git`
 * directory is not a second hole — `entry.isDirectory()` follows the link, and
 * this resolves the link target the same way.
 */
const gitdirIsInsideWorkspace = (workspaceRoot: string, dir: string): boolean => {
  const dotGit = join(dir, '.git')
  let real: string
  try {
    if (statSync(dotGit).isDirectory()) {
      real = realpathSync(dotGit)
    } else {
      const declared = /^\s*gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
      if (declared === undefined) return false
      real = realpathSync(isAbsolute(declared) ? declared : resolve(dir, declared))
    }
  } catch {
    // Unreadable or dangling: cannot be shown to be inside, so it is not.
    return false
  }
  try {
    return isInside(realpathSync(workspaceRoot), real)
  } catch {
    return isInside(workspaceRoot, real)
  }
}

/**
 * Every repo identity that is an actual checkout inside this workspace.
 *
 * VALIDATION INPUT ONLY. The returned set answers "is this declared member
 * really here?" and "is this `archived` member actually present after all?".
 * It is NEVER iterated to build the member list — see the module comment. If
 * you are about to write `for (const source of worktreeSources(...))` and push
 * stores from it, you are re-introducing the auto-discovery design that was
 * rejected.
 * @param root - the session repository's git toplevel.
 */
export const worktreeSources = (root: string): Set<string> => {
  const found = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory is not a reason to fail the whole session
    }
    // `.git` is a FILE in a worktree/submodule checkout and a directory in an
    // ordinary one, so presence is tested by name rather than by type — and
    // then by where its gitdir actually RESOLVES, because a `.git` file is
    // attacker-controlled committed content (see `gitdirIsInsideWorkspace`).
    if (entries.some((entry) => entry.name === '.git') && gitdirIsInsideWorkspace(root, dir)) {
      const identity = deriveRepoIdentity(dir)
      if (identity !== undefined) found.add(identity.source)
    }
    if (depth >= MAX_DEPTH) return
    for (const entry of entries) {
      if (!entry.isDirectory() || PRUNE.has(entry.name)) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(root, 0)
  return found
}

/** A member that passed admission, with the store it names. */
export interface ResolvedMember {
  readonly source: string
  readonly archived: boolean
  readonly store: OpenStore
}

/**
 * Apply the admission rules to a declaration.
 *
 * (a) A non-archived member must be an actual checkout beneath this workspace.
 * (b) An archived member must have a store on disk AND must not satisfy (a) —
 *     a member both present as a checkout and marked archived is a declaration
 *     error, refused loudly rather than silently reinterpreted.
 *
 * The session's own repository is REMOVED rather than refused: listing
 * yourself in your own group is redundant, not dangerous, and failing the whole
 * declaration over it would be a trap with no upside.
 *
 * Stores are reached with `stores.get()` and never `open()`. `openAllKnown()`
 * has already opened every store that exists on disk, so `get()` reaches even
 * an orphaned one; `open()` would mkdir + migrate, letting a declaration
 * CREATE a store out of a source string that never existed. A member whose
 * store is missing is skipped with a warning that includes the DERIVED KEY, so
 * a mistyped source can be diagnosed by comparing that key against the
 * directory names under `repos/`.
 * @param decl - the declaration, already read and fingerprinted.
 * @param stores - registry, consulted read-only.
 * @param selfKey - the session repository's own store key.
 * @param workspaceRoot - the session repository's git toplevel.
 * @param log - warning sink.
 */
export const resolveGroupMembers = (
  decl: GroupDeclaration,
  stores: StoreRegistry,
  selfKey: string,
  workspaceRoot: string,
  log: StoreLogger,
): ResolvedMember[] => {
  const present = worktreeSources(workspaceRoot)
  const resolved: ResolvedMember[] = []
  const seen = new Set<string>()
  for (const member of decl.members) {
    const key = repoKeyFor(member.source)
    if (key === selfKey) continue // the session's own repo: drop, do not refuse
    if (seen.has(key)) {
      log.warn(`strataloom: ${GROUP_FILE} lists ${member.source} twice, using the first entry`)
      continue
    }
    const inWorktree = present.has(member.source)
    if (member.archived) {
      if (inWorktree) {
        log.warn(
          `strataloom: ${GROUP_FILE} marks ${member.source} as archived, but it IS checked out ` +
            'inside this workspace; refusing that member (remove `archived` to include it)',
        )
        continue
      }
    } else if (!inWorktree) {
      log.warn(
        `strataloom: ${GROUP_FILE} member ${member.source} (key ${key}) is not a git checkout ` +
          'inside this workspace; skipping it (mark it `archived: true` if it has none)',
      )
      continue
    }
    const store = stores.get(key)
    if (store === undefined) {
      log.warn(
        `strataloom: ${GROUP_FILE} member ${member.source} has no store on disk ` +
          `(expected repos/${key}/memory.sqlite); skipping it — check the source string spelling`,
      )
      continue
    }
    seen.add(key)
    resolved.push({ source: member.source, archived: member.archived, store })
  }
  return resolved
}

/**
 * The approval prompt.
 *
 * Every archived member is listed INDIVIDUALLY and labelled, because the
 * archived predicate verifies almost nothing (see the module comment) and this
 * sentence is the actual safety mechanism. A summary count would defeat it: the
 * person has to be able to see WHICH repository with no checkout here is about
 * to have its memories read.
 *
 * ## "Nothing is ever written to them" is a CLAIM ABOUT THE CODE
 *
 * It was untrue when it was first written, and how it was untrue is worth
 * keeping: `recall` called `touchUsage` on each member's store, so every
 * approved read ran `INSERT INTO usage … ON CONFLICT DO UPDATE` in a
 * repository this session had only READ access to. Measured on copies of the
 * real stores, seven recall calls modified 4 usage rows in the Backend store
 * and 4 in the orphaned `…_Ops` store — which has no checkout on this machine
 * at all — and both files changed md5 and mtime. The defence at the time was
 * that `usage` is non-authoritative; but `decay` turns `usage.last_hit_at`
 * into `memories.status`, so it was not.
 *
 * The sentence stayed and the CODE moved (see the member loop in
 * `service.recall`), because this prompt is the only place a human weighs the
 * decision and they weigh it on these words. A promise made on the one
 * load-bearing gate is a specification, not a description. If a future change
 * needs to write to a member store, this sentence must change FIRST and the
 * human must be asked again — the fingerprint covers the declaration, not the
 * code, so nothing else here would notice.
 * @param decl - the approved-against declaration.
 * @param members - the members that passed admission.
 */
export const approvalReason = (
  decl: GroupDeclaration,
  members: readonly ResolvedMember[],
): string => {
  const lines = [
    `Let this session READ the memories of ${members.length} other repository/repositories ` +
      `declared in ${GROUP_FILE} (group "${decl.group}"). Nothing is ever written to them: ` +
      'no memory there is saved, changed, forgotten, or even marked as used, and their ' +
      'files are not modified.',
  ]
  for (const member of members) {
    lines.push(
      member.archived
        ? `  - ${member.source}  [ARCHIVED: no checkout inside this workspace. This is your ` +
          'assertion, which nothing here can verify — approve only if you recognise it.]'
        : `  - ${member.source}  (checked out inside this workspace)`,
    )
  }
  return lines.join('\n')
}
