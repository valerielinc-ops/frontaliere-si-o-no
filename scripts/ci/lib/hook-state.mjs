/**
 * Tiny local state for optimization hooks.
 *
 * State lives under the workspace root's `.scratch`, never in a child repo.
 * Marker creation uses a hard link from a fully-written temporary file, so two
 * concurrent first calls cannot both claim the same slot. Any filesystem
 * anomaly returns `unavailable`; callers must then allow the command.
 *
 * A marker is a CLAIM, not a permanent verdict: pass `ttlMs` and an expired
 * claim is taken over instead of being reported as still held. Without it a
 * session that died between the claim and its own work would keep the slot
 * closed forever, and the only way out would be deleting a file by hand under
 * `.scratch/` — which nobody who hits the block knows about.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeRepository } from './hook-command-parser.mjs';

const STATE_DIR_ENV = 'FRONTALIERE_HOOK_STATE_DIR';
const WORKSPACE_ENV = 'WORKSPACE';
export const HOOK_STATE_SCHEMA = 1;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_GIT_TEXT_BYTES = 64 * 1024;

/**
 * @param {string} scope
 * @returns {string|undefined}
 */
export function resolveHookStateDir(scope) {
  if (!/^[a-z0-9-]+$/.test(scope)) return undefined;

  const configured = process.env[STATE_DIR_ENV];
  if (configured !== undefined) {
    if (!configured || !isAbsolute(configured)) return undefined;
    return join(configured, scope);
  }

  // The root hook configurations export WORKSPACE explicitly. Never fall
  // back to a child checkout here: that would violate the requirement that
  // the marker store stays outside every child repository.
  const workspace = validAbsoluteDirectory(process.env[WORKSPACE_ENV]);
  return workspace ? join(workspace, '.scratch', 'hook-state', scope) : undefined;
}

/**
 * Atomically claim a marker. The result is one of `claimed`, `exists`, or
 * `unavailable`; only the first two carry policy meaning.
 *
 * `ttlMs` (optional, positive finite number) makes the claim expire: an
 * existing marker older than the TTL is taken over and the call reports
 * `claimed` with `takeover: true`. The age is read from the record's
 * `createdAt` when it is a parseable timestamp, otherwise from the file mtime.
 * A marker whose age cannot be established is treated as FRESH — expiring on
 * an unreadable timestamp would turn a filesystem oddity into a silently
 * reopened gate.
 *
 * @param {{scope:string,key:string,record:Record<string,unknown>,ttlMs?:number}}
 * @returns {{status:'claimed'|'exists'|'unavailable',path?:string,takeover?:boolean,ageMs?:number,record?:Record<string,unknown>}}
 */
export function claimMarker({ scope, key, record, ttlMs }) {
  const directory = resolveHookStateDir(scope);
  if (!directory || typeof key !== 'string' || !key) return { status: 'unavailable' };

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return { status: 'unavailable' };
  }

  const filename = `${hashKey(key)}.json`;
  const target = join(directory, filename);
  const temporary = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...record })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      linkSync(temporary, target);
      return { status: 'claimed', path: target };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { status: 'unavailable' };
      return resolveExistingMarker({ target, temporary, ttlMs });
    }
  } catch {
    return { status: 'unavailable' };
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Temporary cleanup is best effort and never changes the gate verdict.
    }
  }
}

/**
 * Decide what an already-present marker means, and take it over when its TTL
 * has run out. The takeover is unlink-then-link, not rename: if two callers
 * both see the same expired claim only one wins the link and the other reads
 * the fresh marker back, so an expiry cannot hand the slot to two sessions.
 */
function resolveExistingMarker({ target, temporary, ttlMs }) {
  const existing = readMarker(target);
  if (!existing) return { status: 'unavailable' };

  const ttl = Number(ttlMs);
  const expired = Number.isFinite(ttl) && ttl > 0
    && typeof existing.ageMs === 'number' && existing.ageMs > ttl;
  if (!expired) {
    return {
      status: 'exists',
      path: target,
      record: existing.record,
      ...(typeof existing.ageMs === 'number' ? { ageMs: existing.ageMs } : {}),
    };
  }

  try {
    unlinkSync(target);
  } catch (error) {
    // ENOENT: another caller already took the same expired claim over; fall
    // through and let the link below decide who actually holds it now.
    if (error?.code !== 'ENOENT') return { status: 'unavailable' };
  }
  try {
    linkSync(temporary, target);
    return { status: 'claimed', path: target, takeover: true, ageMs: existing.ageMs };
  } catch (error) {
    if (error?.code !== 'EEXIST') return { status: 'unavailable' };
    const fresh = readMarker(target);
    return fresh
      ? { status: 'exists', path: target, record: fresh.record }
      : { status: 'unavailable' };
  }
}

/**
 * Read a marker plus its age. Returns `undefined` for anything this module did
 * not write (the fail-safe `unavailable` case for the caller).
 *
 * @param {string} path
 * @returns {{record:Record<string,unknown>, ageMs?:number}|undefined}
 */
function readMarker(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1) return undefined;
    return { record: parsed, ...ageOf(parsed, stat) };
  } catch {
    return undefined;
  }
}

/** Age in ms from the record's own timestamp, falling back to the file mtime. */
function ageOf(record, stat) {
  const now = Date.now();
  const declared = Date.parse(String(record?.createdAt ?? ''));
  if (Number.isFinite(declared)) return { ageMs: Math.max(0, now - declared) };
  if (Number.isFinite(stat?.mtimeMs)) return { ageMs: Math.max(0, now - stat.mtimeMs) };
  return {};
}

export function hashKey(key) {
  return createHash('sha256').update(`${HOOK_STATE_SCHEMA}:${key}`).digest('hex').slice(0, 32);
}

/**
 * Resolve a stable local repository identity from the hook payload cwd.
 * Explicit `--repo`/GITHUB_REPOSITORY values remain preferable; this fallback
 * only reads a bounded `.git` pointer and resolves the local origin with
 * `git config`; it never accesses the network. It lets two child repositories
 * with the same PR number keep separate body markers while sharing one marker
 * across their worktrees.
 *
 * @param {unknown} candidate
 * @returns {string|undefined}
 */
export function resolveHookRepositoryScope(candidate = process.cwd()) {
  let current = validAbsoluteDirectory(candidate);
  if (!current) return undefined;

  for (let depth = 0; depth < 16; depth += 1) {
    const commonGitDir = resolveCommonGitDir(join(current, '.git'));
    if (commonGitDir) {
      const remote = readOriginRepository(commonGitDir);
      return remote ?? `git:${commonGitDir}`;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function validAbsoluteDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate || !isAbsolute(candidate)) return undefined;
  try {
    return statSync(candidate).isDirectory() ? resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function resolveCommonGitDir(gitEntry) {
  try {
    const stat = statSync(gitEntry);
    if (stat.isDirectory()) return resolve(gitEntry);
    if (!stat.isFile() || stat.size > 4096) return undefined;

    const pointer = readFileSync(gitEntry, 'utf8').match(/^gitdir:\s*(.+)\s*$/im);
    if (!pointer) return undefined;
    const gitDir = resolve(join(gitEntry, '..'), pointer[1]);
    const commondir = readSmallFile(join(gitDir, 'commondir'))?.trim();
    // A standard linked worktree has `commondir`; without it, do not guess a
    // parent (a submodule's `.git` pointer would otherwise collapse onto the
    // superproject). A unique gitdir is still a safe local namespace.
    return commondir ? resolve(gitDir, commondir) : resolve(gitDir);
  } catch {
    return undefined;
  }
}

function readOriginRepository(commonGitDir) {
  try {
    const output = execFileSync('git', [
      '--git-dir', commonGitDir,
      'config',
      '--local',
      '--includes',
      '--get',
      'remote.origin.url',
    ], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_TEXT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    for (const value of output.trim().split(/\r?\n/).reverse()) {
      const repository = normalizeRepository(value);
      if (repository) return repository;
    }
  } catch {
    // A missing/broken local git config is the fail-safe unknown-target case.
  }
  return undefined;
}

function readSmallFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_GIT_TEXT_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
