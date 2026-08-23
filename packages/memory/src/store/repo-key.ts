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

const hashKey = (source: string): string =>
  createHash('sha256').update(source).digest('hex').slice(0, 24)

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
