/**
 * Publishes the REAL emitted chunk filenames of this build.
 *
 * Chunk filenames are interface-addressed (`mx.3fa9c0de.js`, see
 * shared/abiChunkNaming.mjs), so "the file of chunk `mx`" is no longer
 * derivable by string concatenation. Two consumers need it:
 *
 *  1. The build plugins that write `<link rel="modulepreload">` into the
 *     prerendered pages (staticPagesPlugin, preloadLocalePlugin) resolve a
 *     chunk by its logical name from `closeBundle`. They go through
 *     shared/chunkFiles.ts `stableChunkFile`, which reads the registry filled
 *     here in `generateBundle` — strictly before any `closeBundle` hook, so it
 *     does not depend on Rollup's write phase (the race documented in
 *     chunkFiles.ts).
 *  2. Code OUTSIDE the bundle that has to reach a chunk by name — the live
 *     runtime watchdog and the hydrated-article parity gate — reads
 *     `assets/chunk-manifest.json`, emitted here as a plain asset.
 *
 * The manifest omits ambiguous names (the per-article blog bodies, which share
 * a basename across locales and are addressed by their locale-qualified
 * filename instead).
 */

import type { Plugin } from 'vite';
import { CHUNK_MANIFEST_FILENAME } from './shared/abiChunkNaming';
import {
  builtChunkFilesSnapshot,
  registerBuiltChunkFiles,
  resetBuiltChunkFiles,
} from './shared/chunkFiles';

export function chunkFileRegistryPlugin(): Plugin {
  return {
    name: 'chunk-file-registry',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      resetBuiltChunkFiles();
    },
    generateBundle(_options, bundle) {
      const chunks: { name: string; fileName: string }[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') chunks.push({ name: output.name, fileName: output.fileName });
      }
      registerBuiltChunkFiles(chunks);
      this.emitFile({
        type: 'asset',
        fileName: CHUNK_MANIFEST_FILENAME,
        source: `${JSON.stringify({ v: 1, chunks: builtChunkFilesSnapshot() })}\n`,
      });
    },
  };
}
