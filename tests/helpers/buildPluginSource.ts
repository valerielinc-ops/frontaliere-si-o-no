/**
 * Resolve a build-plugin's REAL source, following the colocation shim.
 *
 * Issue #4881 Fase 6 moved the article engine into `packages/articles/engine/`
 * and left one-line re-export shims at the old `build-plugins/*.ts` paths so
 * every existing import keeps resolving. Guards that read a plugin's source as
 * TEXT (checking it imports a shared constant, doesn't inline a literal, etc.)
 * would otherwise silently start scanning a 9-line shim and pass vacuously —
 * the guard stops guarding without anyone noticing.
 *
 * This helper follows `export * from '<target>'` in a shim and returns the
 * target's source instead, so those guards keep covering the real code. It is
 * deliberately strict: an unresolvable target throws rather than falling back
 * to the shim text, because a silent fallback is the failure mode prevented.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SHIM_RE = /export\s+\*\s+from\s+'([^']+)'/;

/** Absolute path of the real implementation behind `file` (itself if not a shim). */
export function resolveBuildPluginPath(file: string): string {
  const src = readFileSync(file, 'utf-8');
  const m = SHIM_RE.exec(src);
  if (!m) return file;
  const base = resolve(dirname(file), m[1]);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error(`shim ${file} re-exports '${m[1]}' but no such file exists — the guard would silently scan the shim`);
}

/** Source text of the real implementation behind `file`. */
export function readBuildPluginSource(file: string): string {
  return readFileSync(resolveBuildPluginPath(file), 'utf-8');
}
