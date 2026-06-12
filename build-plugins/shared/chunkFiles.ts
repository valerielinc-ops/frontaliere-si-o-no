/**
 * Single source of truth for resolving a built chunk FILE from a chunk NAME
 * inside `dist/assets/`.
 *
 * Chunk filenames are STABLE (`<name>.js`, vite.config.ts `chunkFileNames` —
 * see the rationale there), so the primary match is the exact `name.js`. The
 * legacy content-hashed form (`<name>-<hash>.js`) is kept as a fallback so the
 * resolver still works against a dist built before the stabilization (e.g.
 * audit replays of old deploy artifacts) and so a partial revert of the
 * vite.config naming can't silently drop every modulepreload.
 *
 * Why a shared module: this exact name→file matching used to be copy-pasted
 * as slightly-different regexes in staticPagesPlugin.ts, ogPagesPlugin.ts and
 * preloadLocalePlugin.ts (`/^it-(core|calculator)-[A-Za-z0-9_-]+\.js$/`,
 * `startsWith('vendor-react-')`, …). Drift between those copies is the
 * "stesso anti-pattern nel file gemello" class (AGENTS.md #6) — one definition
 * makes it impossible.
 */

import { VITE_HASH_CHARS } from './viteAssetHashRx';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the built `.js` file for a chunk name among `dist/assets/` filenames.
 * Matches the stable `<name>.js` first, then the legacy `<name>-<hash>.js`.
 * Sourcemaps are never matched. Returns undefined when the chunk is absent
 * (callers treat a missing chunk as "no preload", never as a build failure).
 */
export function findChunkFile(files: readonly string[], name: string): string | undefined {
  const stable = `${name}.js`;
  if (files.includes(stable)) return stable;
  const legacyRx = new RegExp(`^${escapeRegExp(name)}-[${VITE_HASH_CHARS}]+\\.js$`);
  return files.find(f => legacyRx.test(f) && !f.endsWith('.js.map'));
}

/**
 * Find the built `.js` files for several chunk names, in the given order,
 * dropping the ones that don't exist in this build.
 */
export function findChunkFiles(files: readonly string[], names: readonly string[]): string[] {
  return names
    .map(n => findChunkFile(files, n))
    .filter((f): f is string => Boolean(f));
}
