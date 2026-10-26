/**
 * Chunks that must keep a plain `<name>.js`, because something OUTSIDE the Vite
 * build writes their name into HTML.
 *
 * Interface-addressed chunk names (abiChunkNaming.mjs) are resolved inside the
 * build through the registry (chunkFileRegistryPlugin → `stableChunkFile`), so
 * every page the site build emits follows a rename on its own. The article
 * publisher does not run that build: it renders a new article's HTML on its own
 * schedule with the shared engine (packages/articles/engine/ogPagesPlugin.ts)
 * and its mirrored copy of chunkFiles.ts, which has an empty registry and
 * answers `<name>.js`. The chunks that engine preloads must therefore keep that
 * spelling, whatever happens to the rest of the graph:
 *
 *   vendor-react   — grandfathered instead, see GRANDFATHERED_ABI_HASHES
 *   it-core, it-calculator, blog-meta-it — default-only modules
 *
 * Default-only is what makes a plain name safe: there is no named binding for a
 * sibling chunk to fail to link. The post-build verifier turns that premise into
 * a gate — the day one of these gains a named export it fails the build, naming
 * the chunk and the renderer that depends on its spelling, rather than quietly
 * shipping either a skew hole (plain name) or stale preloads in published
 * articles (hashed name).
 *
 * `.mjs` so the raw-`node` post-build verifier can import it.
 */

/** Chunk names (Rollup `chunk.name`) that out-of-build renderers reference by plain filename. */
export const PLAIN_NAME_CHUNKS = Object.freeze(['it-core', 'it-calculator', 'blog-meta-it']);

const PLAIN = new Set(PLAIN_NAME_CHUNKS);

/**
 * @param {string} chunkName
 * @returns {boolean}
 */
export function isPlainNameChunk(chunkName) {
  return PLAIN.has(chunkName);
}
