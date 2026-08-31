/**
 * cwd → repo-key derivation (spec §2.1). Input is ONLY the platform-validated
 * session cwd — never process.cwd() (that is the dsh process's directory, not
 * the session's; D1). Derivation: cwd → git toplevel (realpath) → preferred
 * remote URL normalized (credentials stripped, `.git` suffix dropped, scp-form
 * mapped to URL form) → hash; no remote falls back to the toplevel realpath.
 *
 * The memo on this module IS a cache without an invalidation protocol — the
 * spec accepts that honestly (§4.1): a mid-session remote change goes stale
 * until restart; wrong-store is an availability concern, not a safety one
 * (both stores carry this repo's semantics).
 * @module @strataloom/dsh-memory/store/repo-key
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

/** A derived repo identity: the store key plus diagnostic origin. */
export interface RepoIdentity {
  /** Filesystem-safe hash key under `repos/<key>/memory.sqlite`. */
  readonly key: string
  /** What the hash was computed from (diagnostics; stored in meta). */
  readonly source: string
}

const memo = new Map<string, RepoIdentity | undefined>()

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * Normalize a git remote URL to a canonical comparable form: strip
 * credentials, drop a trailing `.git`/`/`, convert scp-style
 * `user@host:path` to `host/path`, lower-case the host.
 */
export const normalizeRemoteUrl = (raw: string): string => {
  let rest = raw.trim()
  const schemeMatch = /^[a-z+]+:\/\//i.exec(rest)
  if (schemeMatch) {
    rest = rest.slice(schemeMatch[0].length)
  } else {
    // scp-style: user@host:path → host/path
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(rest)
    if (scp) rest = `${scp[1]}/${scp[2]}`
  }
  const at = rest.lastIndexOf('@')
  if (at !== -1 && rest.indexOf('/') > at) rest = rest.slice(at + 1)
  else if (at !== -1 && !rest.slice(0, at).includes('/')) rest = rest.slice(at + 1)
  rest = rest.replace(/\/+$/, '')
  rest = rest.replace(/\.git$/i, '')
  const slash = rest.indexOf('/')
  if (slash === -1) return rest.toLowerCase()
  return rest.slice(0, slash).toLowerCase() + rest.slice(slash)
}

/**
 * Canonicalize a HAND-WRITTEN source string the same way derivation canonicalizes
 * a discovered one.
 *
 * `deriveRepoIdentity` always hashes `remote:` + `normalizeRemoteUrl(url)`, so a
 * declaration that writes the remote in any other accepted spelling — a `.git`
 * suffix, an upper-case host, a trailing slash, scp form — hashes to a DIFFERENT
 * key and silently matches no store. Six spellings of one repository produced
 * six keys before this existed.
 *
 * It is here rather than in `group.ts` for the reason `repoKeyFor` is: the rule
 * that turns a remote into a comparable string must have exactly one
 * implementation, or the declaration side and the derivation side agree only
 * until someone touches one of them.
 *
 * A `path:` source is left alone deliberately — it is already a realpath, and
 * remote normalization (which lower-cases a host and strips a `.git` suffix)
 * would corrupt a legitimate directory name.
 */
export const normalizeSource = (raw: string): string => {
  const trimmed = raw.trim()
  const prefix = 'remote:'
  if (!trimmed.startsWith(prefix)) return trimmed
  return `${prefix}${normalizeRemoteUrl(trimmed.slice(prefix.length))}`
}

const hashKey = (source: string): string =>
  createHash('sha256').update(source).digest('hex').slice(0, 24)

/**
 * The store key for an already-known source string — the same hash the
 * derivation above applies, exposed for the one caller that has a source
 * WITHOUT a checkout to derive it from: a group declaration names its members
 * by source, and an archived member has no working tree left to run git in.
 *
 * Exported rather than re-implemented there, because a second sha256-slice-24
 * expression is the classic "same number typed twice": the day the key changes
 * shape, group lookups would silently miss every store instead of failing.
 */
export const repoKeyFor = (source: string): string => hashKey(normalizeSource(source))

/**
 * Derive the repo identity for a session cwd, or `undefined` when the cwd is
 * not inside a git work tree (no repo affiliation ⇒ empty injection + write
 * refusal upstream — honest, no guessing).
 */
export const deriveRepoIdentity = (cwd: string): RepoIdentity | undefined => {
  if (memo.has(cwd)) return memo.get(cwd)
  const identity = computeRepoIdentity(cwd)
  memo.set(cwd, identity)
  return identity
}

const computeRepoIdentity = (cwd: string): RepoIdentity | undefined => {
  const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
  if (toplevel === undefined || toplevel === '') return undefined
  let canonical: string
  try {
    canonical = realpathSync(toplevel)
  } catch {
    canonical = toplevel
  }
  const remotes = git(canonical, ['remote']) ?? ''
  const names = remotes.split('\n').filter((name) => name !== '')
  const preferred = names.includes('origin') ? 'origin' : names[0]
  if (preferred !== undefined) {
    const url = git(canonical, ['remote', 'get-url', preferred])
    if (url !== undefined && url !== '') {
      const source = `remote:${normalizeRemoteUrl(url)}`
      return { key: hashKey(source), source }
    }
  }
  const source = `path:${canonical}`
  return { key: hashKey(source), source }
}

/**
 * The git work-tree root for a cwd — where a projection belongs. Same
 * derivation as the repo key's toplevel step, exposed because the projection
 * writes into the workspace rather than the harness home.
 */
export const deriveWorkspaceRoot = (cwd: string): string | undefined => {
  const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
  if (toplevel === undefined || toplevel === '') return undefined
  try {
    return realpathSync(toplevel)
  } catch {
    return toplevel
  }
}

/** Test seam: clear the cwd memo. */
export const clearRepoIdentityMemo = (): void => {
  memo.clear()
}
