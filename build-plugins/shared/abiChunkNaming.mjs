/**
 * Interface-addressed (ABI) chunk filenames — the structural fix for the
 * cross-chunk version-skew SyntaxError family:
 *
 *   WebKit: `SyntaxError: Importing binding name 'isLikelyBot' is not found.`
 *   V8:     `The requested module './x.js' does not provide an export named …`
 *
 * Why it kept happening
 * ---------------------
 * Chunk filenames are stable (no content hash, vite.config.ts) while a chunk's
 * EXPORT SET is not fixed: Rollup only exports from a shared chunk the names
 * that some OTHER chunk imports in THIS build, and it re-homes modules between
 * chunks whenever an import edge appears or disappears elsewhere. So one
 * deploy can move `isLikelyBot` out of `mx.js`, or stop re-exporting
 * `statedWorkloadPercent` from `jobDataNormalization.js`, and any browser that
 * still holds an importer chunk from the previous generation (HTTP cache,
 * `max-age=600`; a tab open across the deploy; the non-atomic CDN upload)
 * links it against the new file and dies at module-link time, before React
 * mounts. Patching the one symbol that broke (re-export shims, #15179 and
 * #15355) cannot close the class: the next module move breaks a different one.
 *
 * The fix
 * -------
 * Put the export set INTO the filename. A chunk whose named exports change gets
 * a new URL (`mx.3fa9c0de.js`); a chunk whose named exports are unchanged keeps
 * its URL, whatever its body. Then, for any two generations:
 *
 *  - an importer from generation N asks for `D.<h_N>.js`, the file whose export
 *    names are exactly the ones that importer was linked against — and the CDN
 *    still serves it (additive publish; the janitor only prunes after the
 *    grace window), so it can never meet a dependency with fewer names;
 *  - an importer from generation N+1 asks for `D.<h_N+1>.js`, a URL no browser
 *    can hold in cache from an older generation, so it can never meet a stale
 *    dependency with fewer names either;
 *  - when the export names did not change, both generations share the URL and
 *    every named binding resolves in either body.
 *
 * Both directions of the skew become impossible by construction, instead of
 * being detected by the post-deploy monitor after users have already crashed.
 *
 * What is deliberately NOT keyed
 * ------------------------------
 *  - The SPA entry (`entryFileNames`, `index-entry.js`) — fixed, referenced by
 *    every prerendered page; it must export nothing (verify-spa-entry-assets).
 *  - Chunks with no named export (default-only modules: it-core, it-calculator,
 *    blog-meta-it, the per-article blog bodies): nothing a sibling can fail to
 *    link, so their URL does not need to move.
 *  - The few chunks a renderer OUTSIDE the Vite build writes into HTML by plain
 *    name (plainNameChunks.mjs: the article publisher's preloads). They must
 *    stay default-only; the post-build verifier enforces it.
 *  - `vendor-react`, which every page preloads AND other chunks import from,
 *    keeps the plain name only while its export set equals the recorded
 *    production one (GRANDFATHERED_ABI_HASHES). This is what keeps the ~1.28M
 *    prerendered pages (jobs, articles — which reference only the chunks above)
 *    byte-identical across deploys: a rename only ever touches pages the build
 *    itself regenerates, through the registry.
 *  - Value-level skew (same export name, different behaviour) — that is the
 *    call-time TypeError class, handled by the runtime self-heal.
 *
 * This relies on `output.minifyInternalExports: false` (vite.config.ts): with
 * the default `true`, export names are re-lettered every build and the hash
 * would rotate on every deploy. tests/abi-chunk-naming.test.ts pins that.
 *
 * `.mjs` (not `.ts`) so raw-`node` CI scripts (runtime watchdog, parity gate)
 * can import it; `abiChunkNaming.ts` re-exports it for build-plugin consumers
 * (same pattern as `viteAssetHashRx.mjs` / `viteAssetHashRx.ts`).
 */

import { createHash } from 'node:crypto';
import { isPlainNameChunk } from './plainNameChunks.mjs';

/** Hex chars of the interface hash in the filename: 8 hex = 32 bits, ample for a few hundred chunks. */
export const ABI_HASH_LENGTH = 8;

/**
 * Chunks whose CURRENT interface keeps the plain `<name>.js`, so that adopting
 * interface-addressed names does not re-emit every prerendered page once.
 *
 * `vendor-react` is the one chunk that both (a) every prerendered page
 * preloads by name — including the articles the publisher renders outside the
 * build — and (b) other chunks import named bindings from (React's interop
 * helpers). It cannot be left plain forever (that is the exposure this scheme
 * removes) and it cannot simply be hashed without a one-off rewrite of every
 * page. Grandfathering gives both: while its export names equal the production
 * set recorded here it keeps the plain name; the day they differ it gets a
 * hashed name (a one-off page rewrite, then stable again) and the previous
 * plain file stays on the CDN for the importers linked against it.
 *
 * The invariant is unchanged — a given filename always denotes ONE interface —
 * the plain name just denotes the baseline one. Never edit a hash here to
 * "make a build pass": it must stay the interface of the plain file on the CDN.
 */
export const GRANDFATHERED_ABI_HASHES = Object.freeze({
  // React, React$1, client, commonjsGlobal, getAugmentedNamespace,
  // getDefaultExportFromCjs, jsxRuntimeExports, reactDomExports, reactExports,
  // requireReact — read from the live https://cdn.frontaliereticino.ch/assets/vendor-react.js
  'vendor-react': 'e369775a',
});

/** `<base>.<8 hex>.js` — the suffix this module adds, never produced by any other naming path. */
export const ABI_SUFFIX_RX = new RegExp(`\\.([0-9a-f]{${ABI_HASH_LENGTH}})\\.js$`);

/**
 * Where the build publishes the logical-name → emitted-filename map. Consumers
 * that must reach a chunk BY NAME from outside the bundle (the live watchdog,
 * the hydrated-parity gate) read it instead of guessing `<name>.js`.
 */
export const CHUNK_MANIFEST_FILENAME = 'assets/chunk-manifest.json';

/**
 * Build-time kill switch. Interface-addressed names are on by default;
 * `SPA_ABI_CHUNK_NAMES=0` restores the previous stable `<name>.js` names for one
 * build (revert path if a deploy ever has to be unblocked without a code revert).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isAbiChunkNamingEnabled(env = process.env) {
  return env.SPA_ABI_CHUNK_NAMES !== '0';
}

/**
 * The chunk's NAMED exports: unique, sorted, `default` excluded.
 *
 * @param {readonly string[] | null | undefined} exports
 * @returns {string[]}
 */
export function namedChunkExports(exports) {
  return [...new Set(exports ?? [])].filter((name) => name !== 'default').sort();
}

/**
 * Interface hash of a chunk, or '' when it has no named export (nothing to
 * link against by name → the URL needs no suffix). Pure and order-independent.
 *
 * @param {readonly string[] | null | undefined} exports
 * @returns {string}
 */
export function chunkAbiHash(exports) {
  const named = namedChunkExports(exports);
  if (named.length === 0) return '';
  return createHash('sha1').update(`abi1\n${named.join('\n')}`).digest('hex').slice(0, ABI_HASH_LENGTH);
}

/**
 * Insert the interface hash before the extension: `assets/mx.js` →
 * `assets/mx.3fa9c0de.js`. Returns the input unchanged for default-only chunks.
 * Policy-free: it suffixes whatever it is given; see `abiChunkFileName` for the
 * rule the build applies.
 *
 * @param {string} fileName
 * @param {readonly string[] | null | undefined} exports
 * @returns {string}
 */
export function withAbiSuffix(fileName, exports) {
  const hash = chunkAbiHash(exports);
  if (!hash) return fileName;
  if (!fileName.endsWith('.js')) return fileName;
  return `${fileName.slice(0, -'.js'.length)}.${hash}.js`;
}

/**
 * The interface hash a chunk's filename must carry, or '' when it keeps the
 * plain name. The single policy shared by `chunkFileNames` (vite.config.ts) and
 * the post-build verifier, so the two cannot disagree.
 *
 * Plain name when the chunk
 *  - has no named export (nothing to link by name), or
 *  - is one a renderer outside the build writes by plain name
 *    (plainNameChunks.mjs). It is meant to be default-only; if it ever gains a
 *    named export it stays plain HERE and the verifier fails the build, instead
 *    of this function silently hashing a name that published articles still
 *    spell without the hash, or
 *  - still has its grandfathered baseline interface (GRANDFATHERED_ABI_HASHES).
 *
 * @param {string} chunkName  Rollup `chunk.name` (logical name, no extension)
 * @param {readonly string[] | null | undefined} exports
 * @returns {string}
 */
export function expectedAbiHash(chunkName, exports) {
  if (isPlainNameChunk(chunkName)) return '';
  const hash = chunkAbiHash(exports);
  if (!hash) return '';
  if (GRANDFATHERED_ABI_HASHES[chunkName] === hash) return '';
  return hash;
}

/**
 * The filename `chunkFileNames` returns for a chunk, given the plain name it
 * would otherwise get.
 *
 * @param {string} fileName   e.g. `assets/mx.js`
 * @param {string} chunkName  Rollup `chunk.name`, e.g. `mx`
 * @param {readonly string[] | null | undefined} exports
 * @returns {string}
 */
export function abiChunkFileName(fileName, chunkName, exports) {
  return expectedAbiHash(chunkName, exports) ? withAbiSuffix(fileName, exports) : fileName;
}

/**
 * Split an emitted filename into its logical base and interface hash, or null
 * if it carries none.
 *
 * @param {string} fileName
 * @returns {{ base: string, hash: string } | null}
 */
export function parseAbiSuffix(fileName) {
  const m = ABI_SUFFIX_RX.exec(fileName);
  if (!m) return null;
  return { base: `${fileName.slice(0, m.index)}.js`, hash: m[1] };
}

/**
 * True for a parsed `assets/chunk-manifest.json` of the shape this build
 * publishes. Anything else (a 404 body, an HTML error page, a truncated
 * download) is NOT a manifest and must never be read as "no chunk is renamed".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isChunkManifest(value) {
  const m = /** @type {{ v?: unknown, chunks?: unknown } | null} */ (value);
  return Boolean(m) && typeof m === 'object' && m.v === 1
    && Boolean(m.chunks) && typeof m.chunks === 'object' && !Array.isArray(m.chunks);
}

/**
 * The emitted file of a logical chunk name according to a VALID manifest, or
 * undefined when the manifest does not list it. Deliberately has no
 * `<name>.js` fallback: once chunks are renamed by interface, the plain
 * spelling of a renamed chunk is an older generation's file that the CDN still
 * serves with a 200 — probing it would report a broken deploy as healthy.
 *
 * @param {{ chunks: Record<string, string> }} manifest  a manifest that passed `isChunkManifest`
 * @param {string} name
 * @returns {string | undefined}
 */
export function chunkFileInManifest(manifest, name) {
  const file = manifest.chunks[name];
  return typeof file === 'string' && file ? file : undefined;
}

/**
 * Does this entry chunk import interface-hashed files (`./i18n.a56b3675.js`)?
 * That is how a consumer outside the build tells a generation published by the
 * interface-addressed build from an older one, whose plain `<name>.js` spellings
 * are still the real names. The entry always imports the `i18n` hub, which
 * exports many names and is therefore always hashed.
 *
 * @param {string | null | undefined} entrySource  text of `index-entry.js`
 * @returns {boolean}
 */
export function usesInterfaceAddressedNames(entrySource) {
  return new RegExp(`["']\\./[^"']*\\.[0-9a-f]{${ABI_HASH_LENGTH}}\\.js["']`).test(String(entrySource ?? ''));
}
