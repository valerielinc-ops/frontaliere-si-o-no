/**
 * Post-build checks for the interface-addressed chunk naming
 * (build-plugins/shared/abiChunkNaming.mjs). They read the EMITTED files, not
 * the Rollup configuration, so they fail on what would actually be served:
 *
 *  1. every emitted chunk's filename agrees with its real export names — a
 *     suffix that does not match means the name was computed from a different
 *     interface than the one shipped, which silently re-opens the version-skew
 *     hole this naming exists to close;
 *  2. the SPA entry exports nothing — it keeps a fixed filename, so any name
 *     another chunk imports from it is an unprotected cross-generation binding;
 *  3. the chunks a renderer outside the build spells by plain name
 *     (plainNameChunks.mjs: the article publisher's preloads) stay
 *     default-only — a named export on one of them is a binding no file name
 *     protects, and hashing it would leave published articles pointing at the
 *     old spelling;
 *  4. every `/assets/*.js|css` chunk reference in the prerendered HTML names a
 *     file that was emitted — a rename the preload emitters did not follow
 *     would otherwise ship as 404 hints (and the 404 handlers in index.html
 *     react by reloading).
 *
 * Pure functions over the already-parsed module graph
 * (`scripts/verify-spa-module-links.mjs`) so they are unit-testable without a
 * build; verify-spa-entry-assets.mjs does the disk I/O.
 */

import { expectedAbiHash, parseAbiSuffix } from '../../build-plugins/shared/abiChunkNaming.mjs';
import { isPlainNameChunk } from '../../build-plugins/shared/plainNameChunks.mjs';

/**
 * Per-article blog bodies are keyed by locale (`slug.it.js`, `slug.ch.it.js`)
 * and are default-only by contract (blogBodyChunkNaming.ts); they are exempt
 * from the suffix rule.
 */
const LOCALE_KEYED_CHUNK_RX = /\.(?:ch\.)?(?:it|en|de|fr)\.js$/;

/** `https://cdn…/assets/sub/x.js` → `sub/x.js` (the path relative to dist/assets). */
function assetRelativePath(moduleUrl) {
  try {
    return new URL(moduleUrl).pathname.replace(/^\/assets\//, '');
  } catch {
    return moduleUrl;
  }
}

/** `sub/mx.3fa9c0de.js` → `mx`: the Rollup chunk name the filename was derived from. */
function chunkNameOf(file) {
  const base = file.split('/').pop() ?? file;
  const parsed = parseAbiSuffix(base);
  return (parsed ? parsed.base : base).replace(/\.js$/, '');
}

/**
 * @param {Map<string, { exports: Iterable<string> }>} modules  module URL → parsed links
 * @param {{ entryFile?: string }} [opts]
 * @returns {{ file: string, kind: string, detail: string }[]}
 */
export function checkChunkInterfaceNames(modules, { entryFile = 'index-entry.js' } = {}) {
  const problems = [];
  for (const [moduleUrl, mod] of modules) {
    const file = assetRelativePath(moduleUrl);
    const exported = [...mod.exports];

    // (3) a chunk spelled by plain name outside the build must stay default-only.
    if (file.endsWith('.js') && isPlainNameChunk(chunkNameOf(file))) {
      const named = exported.filter((name) => name !== 'default');
      if (named.length > 0) {
        problems.push({
          file,
          kind: 'plain_chunk_has_exports',
          detail: `exports ${named.sort().join(', ')}, but ${chunkNameOf(file)} is referenced by its plain name from HTML rendered outside the build (build-plugins/shared/plainNameChunks.mjs) — keep it default-only, or move the named exports to another module`,
        });
      }
    }

    if (file === entryFile) {
      const named = exported.filter((name) => name !== 'default');
      if (named.length > 0) {
        problems.push({
          file,
          kind: 'entry_exports',
          detail: `the SPA entry has a fixed filename but exports ${named.sort().join(', ')}`,
        });
      }
      continue;
    }
    if (LOCALE_KEYED_CHUNK_RX.test(file)) continue;
    // Not a Rollup chunk: content-hashed bundler assets such as
    // `pdf.worker-CPbhI6B3.mjs` (assetFileNames), named by their own hash.
    if (!file.endsWith('.js')) continue;

    const expected = expectedAbiHash(chunkNameOf(file), exported);
    const actual = parseAbiSuffix(file)?.hash ?? '';
    if (expected !== actual) {
      problems.push({
        file,
        kind: expected ? (actual ? 'abi_mismatch' : 'abi_missing') : 'abi_unexpected',
        detail: expected
          ? `exports ${exported.filter((n) => n !== 'default').sort().join(', ')} → expected suffix .${expected}, found ${actual ? `.${actual}` : 'none'}`
          : `the filename carries .${actual} but this chunk keeps a plain name (no named export, referenced by prerendered pages, or still on its baseline interface)`,
      });
    }
  }
  return problems;
}

const ASSET_REF_RX = /(?:src|href)=["'](?:https?:\/\/[^"'/]+)?\/assets\/([^"'?#\s]+\.(?:m?js|css))["']/g;

/**
 * Report the HTML references this naming scheme could have broken, and only
 * those: a reference to the plain `<name>.js` of a chunk that is now emitted
 * only as `<name>.<hash>.js` (a preload emitter that did not follow the
 * rename), or a reference to an interface-hashed file that was not emitted.
 * Assets that never go through Rollup (scripts copied from public/) are not
 * judged here — their existence is not what changed.
 *
 * @param {Map<string, string>} htmlByPath  relative HTML path → HTML
 * @param {ReadonlySet<string>} assetFiles  files present in dist/assets (relative to it)
 * @returns {{ page: string, asset: string, reason: string }[]}
 */
export function checkHtmlAssetReferences(htmlByPath, assetFiles) {
  const renamedBases = new Set();
  for (const file of assetFiles) {
    const parsed = parseAbiSuffix(file);
    if (parsed) renamedBases.add(parsed.base);
  }
  const missing = [];
  for (const [page, html] of htmlByPath) {
    for (const match of html.matchAll(ASSET_REF_RX)) {
      const asset = match[1];
      if (assetFiles.has(asset)) continue;
      if (parseAbiSuffix(asset)) {
        missing.push({ page, asset, reason: 'interface-hashed file not emitted' });
      } else if (renamedBases.has(asset)) {
        missing.push({ page, asset, reason: 'chunk is emitted only under its interface-hashed name' });
      }
    }
  }
  return missing;
}

/** @param {{ file: string, kind: string, detail: string }[]} problems */
export function formatInterfaceProblems(problems) {
  return problems.map((p) => `- ${p.file} (${p.kind}): ${p.detail}`);
}
