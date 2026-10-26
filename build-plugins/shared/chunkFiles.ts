/**
 * Single source of truth for resolving a built chunk FILE from a chunk NAME
 * inside `dist/assets/`.
 *
 * Chunk filenames carry no CONTENT hash (vite.config.ts `chunkFileNames` — see
 * the rationale there): `<name>.js`, plus an INTERFACE hash
 * (`<name>.<abi-hash>.js`, abiChunkNaming.mjs) for the chunks that export
 * names, which is what makes cross-generation module linking safe. The SPA
 * entry stays fixed (#4763). `stableChunkFile`/`stableChunkFiles` are the
 * PRIMARY resolvers — an in-memory lookup in the registry that
 * chunkFileRegistryPlugin fills from this build's bundle (zero disk I/O) —
 * and are what every closeBundle-time caller should use.
 * `findChunkFile`/`findChunkFiles` (disk-based: exact `<name>.js` first, then
 * the interface-hashed form, then the legacy content-hashed
 * `<name>-<hash>.js`) exist ONLY as an explicit fallback for a dist built
 * before the naming stabilization (e.g. audit replays of old deploy
 * artifacts) — never call them from a closeBundle hook mid-build:
 * `fs.readdirSync(dist/assets)` there can race Rollup's write phase, which
 * hasn't reliably finished within any closeBundle hook for this build (see
 * docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames) and can return
 * an incomplete listing, degrading preload hints silently (#4762).
 *
 * Why a shared module: this exact name→file matching used to be copy-pasted
 * as slightly-different regexes in staticPagesPlugin.ts, ogPagesPlugin.ts and
 * preloadLocalePlugin.ts (`/^it-(core|calculator)-[A-Za-z0-9_-]+\.js$/`,
 * `startsWith('vendor-react-')`, …). Drift between those copies is the
 * "stesso anti-pattern nel file gemello" class (AGENTS.md #6) — one definition
 * makes it impossible.
 */

import { VITE_HASH_CHARS } from './viteAssetHashRx';

/**
 * Hex digits of the interface hash in `<name>.<hash>.js`. A literal copy of
 * `ABI_HASH_LENGTH` (abiChunkNaming.mjs) on purpose: this file is mirrored
 * byte-identically into the publisher repo (`host/shared/chunkFiles.ts`,
 * loop-sync mode `identical`), which does not carry abiChunkNaming.mjs, so it
 * must not import it. tests/abi-chunk-naming.test.ts fails if the two drift.
 */
const ABI_HASH_LENGTH = 8;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Logical chunk name → emitted `.js` basename, for THIS build. Filled by
 * chunkFileRegistryPlugin in `generateBundle` (before every `closeBundle` hook
 * that calls `stableChunkFile`), so a chunk whose filename carries an
 * interface hash (abiChunkNaming.mjs) is still reachable by its logical name
 * with no disk I/O and no dependence on Rollup's write phase.
 */
const builtChunkFiles = new Map<string, string>();

/** Forget the previous build's names (watch mode / repeated builds in one process). */
export function resetBuiltChunkFiles(): void {
  builtChunkFiles.clear();
}

/**
 * Record the emitted chunk filenames of this build. A logical name that more
 * than one chunk carries (per-article blog bodies share `slug` across locales)
 * is ambiguous and is NOT registered — those chunks are keyed by their own
 * locale-qualified filename and never looked up by bare name.
 */
export function registerBuiltChunkFiles(
  chunks: Iterable<{ name: string; fileName: string }>,
): void {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { name, fileName } of chunks) {
    const base = fileName.slice(fileName.lastIndexOf('/') + 1);
    if (seen.has(name)) ambiguous.add(name);
    else seen.set(name, base);
  }
  for (const [name, base] of seen) {
    if (!ambiguous.has(name)) builtChunkFiles.set(name, base);
  }
}

/** Snapshot of the registry, for the published chunk manifest. */
export function builtChunkFilesSnapshot(): Record<string, string> {
  return Object.fromEntries([...builtChunkFiles].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Resolve the `.js` filename for a chunk name — no disk I/O. Since chunk
 * filenames became interface-addressed (abiChunkNaming.mjs) the name is
 * `<name>.js` only for chunks without named exports; every closeBundle-time
 * caller still goes through here, so the registry (this build's real names)
 * answers first and the plain `<name>.js` spelling is the fallback for a
 * chunk the registry does not know (and for unit tests that never ran a build).
 */
export function stableChunkFile(name: string): string {
  return builtChunkFiles.get(name) ?? `${name}.js`;
}

/** Resolve several chunk names, in order — see `stableChunkFile`. */
export function stableChunkFiles(names: readonly string[]): string[] {
  return names.map(stableChunkFile);
}

/**
 * Find the built `.js` file for a chunk name among `dist/assets/` filenames.
 * Matches the exact `<name>.js` first, then the interface-addressed
 * `<name>.<abi-hash>.js`, then the legacy `<name>-<hash>.js`.
 * Sourcemaps are never matched. Returns undefined when the chunk is absent.
 * Disk-based legacy-hash fallback ONLY — see module docstring for why this
 * must not be called mid-build from a closeBundle hook.
 */
export function findChunkFile(files: readonly string[], name: string): string | undefined {
  const stable = `${name}.js`;
  if (files.includes(stable)) return stable;
  const abiRx = new RegExp(`^${escapeRegExp(name)}\\.[0-9a-f]{${ABI_HASH_LENGTH}}\\.js$`);
  const abi = files.find(f => abiRx.test(f));
  if (abi) return abi;
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
