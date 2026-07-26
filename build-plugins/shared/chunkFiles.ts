/**
 * Single source of truth for resolving a built chunk FILE from a chunk NAME
 * inside `dist/assets/`.
 *
 * Chunk filenames are STABLE (`<name>.js`, vite.config.ts `chunkFileNames` —
 * see the rationale there): the name is fixed at config-authoring time, the
 * same fact `spaBundleResolver.ts` relies on for the SPA entry chunk (#4763).
 * `stableChunkFile`/`stableChunkFiles` are the PRIMARY resolvers — pure string
 * construction, zero disk I/O — and are what every closeBundle-time caller
 * should use. `findChunkFile`/`findChunkFiles` (disk-based: exact stable name
 * first, then the legacy content-hashed `<name>-<hash>.js` form) exist ONLY as
 * an explicit fallback for a dist built before the naming stabilization (e.g.
 * audit replays of old deploy artifacts) — never call them from a closeBundle
 * hook mid-build: `fs.readdirSync(dist/assets)` there can race Rollup's write
 * phase, which hasn't reliably finished within any closeBundle hook for this
 * build (see docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames) and
 * can return an incomplete listing, degrading preload hints silently (#4762).
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
 * Build the stable `.js` filename for a chunk name — no disk I/O. Chunk
 * filenames are fixed by vite.config.ts's `chunkFileNames`, so a caller that
 * already knows a chunk's logical name doesn't need to enumerate
 * `dist/assets/` to find its file: it's always `<name>.js`.
 */
export function stableChunkFile(name: string): string {
  return `${name}.js`;
}

/** Build the stable `.js` filenames for several chunk names, in order. */
export function stableChunkFiles(names: readonly string[]): string[] {
  return names.map(stableChunkFile);
}

/**
 * Find the built `.js` file for a chunk name among `dist/assets/` filenames.
 * Matches the stable `<name>.js` first, then the legacy `<name>-<hash>.js`.
 * Sourcemaps are never matched. Returns undefined when the chunk is absent.
 * Disk-based legacy-hash fallback ONLY — see module docstring for why this
 * must not be called mid-build from a closeBundle hook.
 */
export function findChunkFile(files: readonly string[], name: string): string | undefined {
  const stable = `${name}.js`;
  if (files.includes(stable)) return stable;
  const legacyRx = new RegExp(`^${escapeRegExp(name)}-[${VITE_HASH_CHARS}]+\\.js$`);
  return files.find(f => legacyRx.test(f) && !f.endsWith('.js.map'));
}

/**
 * Find the built `.js` files for several chunk names, in the given order,
 * dropping the ones that don't exist in this build. Disk-based legacy-hash
 * fallback ONLY — see module docstring.
 */
export function findChunkFiles(files: readonly string[], names: readonly string[]): string[] {
  return names
    .map(n => findChunkFile(files, n))
    .filter((f): f is string => Boolean(f));
}
