/**
 * Explicit handoff between the two Vite processes of the staged build.
 *
 * `scripts/ci/build-staged.mjs` runs `BUILD_STAGE=bundle` (corePlugins) and then
 * `BUILD_STAGE=ssg` (seoPlugins + finalOutputPlugins) as separate Node processes.
 * Module state does not cross that boundary: #18780 split the build and the
 * `jobCanonInputs` map written by `localeJobsSplitPlugin` in the first process was
 * `null` in the second, so every IT build failed ~2 h into the SSG
 * (run 43643571377: "localeJobsSplitPlugin did not provide ordering fields in this
 * Vite process"). Anything a core plugin computes in memory and an SEO/final plugin
 * reads must go through this module.
 *
 * The directory is created by `build-staged.mjs` OUTSIDE `dist/` (which is
 * published), passed to both stages in BUILD_STAGE_HANDOFF_DIR, and removed when
 * the runner ends. With the variable unset (the `single` in-process build, tests)
 * every function is a no-op and callers keep their in-memory behaviour.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_STAGE_HANDOFF_ENV = 'BUILD_STAGE_HANDOFF_DIR';

export function stageHandoffDir(): string | null {
  const dir = (process.env[BUILD_STAGE_HANDOFF_ENV] || '').trim();
  return dir ? path.resolve(dir) : null;
}

export function stageHandoffPath(name: string): string | null {
  const dir = stageHandoffDir();
  return dir ? path.join(dir, name) : null;
}

/** Atomic (tmp + rename) JSON write. Returns false when no handoff dir is configured. */
export function writeStageHandoff(name: string, data: unknown): boolean {
  const target = stageHandoffPath(name);
  if (!target) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
  return true;
}

export type StageHandoffRead<T> =
  | { status: 'unconfigured' }
  | { status: 'missing'; path: string }
  | { status: 'unreadable'; path: string; reason: string }
  | { status: 'ok'; path: string; data: T };

export function readStageHandoff<T = unknown>(name: string): StageHandoffRead<T> {
  const file = stageHandoffPath(name);
  if (!file) return { status: 'unconfigured' };
  if (!fs.existsSync(file)) return { status: 'missing', path: file };
  try {
    return { status: 'ok', path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) as T };
  } catch (error) {
    return { status: 'unreadable', path: file, reason: error instanceof Error ? error.message : String(error) };
  }
}
