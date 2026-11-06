/**
 * Register the snapshot-local runtime shims before a launchd process imports
 * optional Firebase dependencies. The launch agent refreshes its installed
 * launcher after a run, so the first process after a code update can still be
 * started by an older launcher that has not exported NODE_PATH yet.
 */
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOCIAL_ROBOT_RUNTIME_SHIMS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'runtime-shims',
);

/** Make the launchd-only fallback visible to CommonJS resolution. */
export function configureSocialRobotRuntime() {
  const current = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  if (!current.includes(SOCIAL_ROBOT_RUNTIME_SHIMS)) {
    process.env.NODE_PATH = [SOCIAL_ROBOT_RUNTIME_SHIMS, ...current].join(path.delimiter);
  }
  // NODE_PATH is read while Node starts. Refresh the CommonJS search paths as
  // well because this function is deliberately called after process startup.
  Module._initPaths();
  return SOCIAL_ROBOT_RUNTIME_SHIMS;
}
