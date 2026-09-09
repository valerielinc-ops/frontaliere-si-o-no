/**
 * Tiny local state for optimization hooks.
 *
 * State lives under the workspace root's `.scratch`, never in a child repo.
 * Marker creation uses a hard link from a fully-written temporary file, so two
 * concurrent first calls cannot both claim the same slot. Any filesystem
 * anomaly returns `unavailable`; callers must then allow the command.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const STATE_DIR_ENV = 'FRONTALIERE_HOOK_STATE_DIR';
const WORKSPACE_ENV = 'WORKSPACE';
const MAX_MARKER_BYTES = 16 * 1024;

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

  const workspace = validAbsoluteDirectory(process.env[WORKSPACE_ENV]);
  const root = workspace ?? findWorkspaceRoot(process.cwd());
  return root ? join(root, '.scratch', 'hook-state', scope) : undefined;
}

/**
 * Atomically claim a marker. The result is one of `claimed`, `exists`, or
 * `unavailable`; only the first two carry policy meaning.
 *
 * @param {{scope:string,key:string,record:Record<string,unknown>}}
 * @returns {{status:'claimed'|'exists'|'unavailable',path?:string}}
 */
export function claimMarker({ scope, key, record }) {
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
      return validMarker(target) ? { status: 'exists', path: target } : { status: 'unavailable' };
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

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function validMarker(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return false;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.version === 1;
  } catch {
    return false;
  }
}

function validAbsoluteDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate || !isAbsolute(candidate)) return undefined;
  try {
    return statSync(candidate).isDirectory() ? resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function findWorkspaceRoot(start) {
  let current;
  try {
    current = resolve(start);
  } catch {
    return undefined;
  }

  for (let depth = 0; depth < 16; depth += 1) {
    if (validAbsoluteDirectory(join(current, 'frontaliere-si-o-no')) && hasGitEntry(join(current, '.git'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function hasGitEntry(candidate) {
  try {
    statSync(candidate);
    return true;
  } catch {
    return false;
  }
}
