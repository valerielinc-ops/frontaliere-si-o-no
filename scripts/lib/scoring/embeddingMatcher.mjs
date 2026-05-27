// scripts/lib/scoring/embeddingMatcher.mjs
//
// Read the binary embedding store produced by Phase 1
// (`scripts/build-article-embeddings.mjs`) and find top-K cosine
// nearest neighbours for a query vector.
//
// Binary format (must stay in sync with build-article-embeddings.mjs):
//   Header (32 bytes): magic "EMBV1\0\0\0" (8B) + count uint32 LE (4B)
//                    + dim uint32 LE (4B) + reserved (16B)
//   Per record: 32B sha256 slug-hash + (dim × 4B) float32 payload
//
// Spec: design doc § 5.5.

import { existsSync, readFileSync } from 'node:fs';

import {
  ARTICLE_EMBEDDINGS_BIN_PATH,
  ARTICLE_EMBEDDINGS_META_PATH,
  EMBEDDING_TOP_K,
} from './constants.mjs';

const HEADER_BYTES = 32;
const HASH_BYTES = 32;
const MAGIC_PREFIX = 'EMBV1';

let cachedStore = null; // process-level memoization keyed by binPath
let cachedMeta = null;

/**
 * Load the binary embedding store. Cached per-process so repeated calls
 * (one per slot) don't re-read 30 MB from disk.
 *
 * @param {{ binPath?: string, metaPath?: string, force?: boolean }} [opts]
 * @returns {{ vectors: Float32Array[], hashes: string[], dim: number, count: number }|null}
 */
export function loadEmbeddingStore(opts = {}) {
  const binPath = opts.binPath || ARTICLE_EMBEDDINGS_BIN_PATH;
  if (!opts.force && cachedStore && cachedStore.__binPath === binPath) return cachedStore;

  if (!existsSync(binPath)) {
    cachedStore = null;
    return null;
  }
  const buf = readFileSync(binPath);
  if (buf.length < HEADER_BYTES) return null;
  const magic = buf.subarray(0, MAGIC_PREFIX.length).toString('binary');
  if (magic !== MAGIC_PREFIX) return null;
  const count = buf.readUInt32LE(8);
  const dim = buf.readUInt32LE(12);
  const recordBytes = HASH_BYTES + dim * 4;
  const expectedSize = HEADER_BYTES + count * recordBytes;
  if (buf.length !== expectedSize) return null;

  const vectors = new Array(count);
  const hashes = new Array(count);
  let off = HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    hashes[i] = buf.subarray(off, off + HASH_BYTES).toString('hex');
    const vecStart = off + HASH_BYTES;
    // Use a Float32Array view aligned to a copied slice — readFileSync
    // returns a Buffer that may not be 4-byte aligned for Float32Array.
    const slice = buf.subarray(vecStart, vecStart + dim * 4);
    const aligned = Buffer.alloc(dim * 4);
    slice.copy(aligned);
    vectors[i] = new Float32Array(aligned.buffer, aligned.byteOffset, dim);
    off += recordBytes;
  }
  cachedStore = { vectors, hashes, dim, count, __binPath: binPath };
  return cachedStore;
}

/**
 * Load the sidecar meta JSON so callers can map slug-hash → slug.
 *
 * @param {{ metaPath?: string, force?: boolean }} [opts]
 * @returns {{ perArticle: Record<string, {hash: string, byteOffset: number}>, dim: number, count: number }|null}
 */
export function loadEmbeddingMeta(opts = {}) {
  const metaPath = opts.metaPath || ARTICLE_EMBEDDINGS_META_PATH;
  if (!opts.force && cachedMeta && cachedMeta.__metaPath === metaPath) return cachedMeta;
  if (!existsSync(metaPath)) {
    cachedMeta = null;
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    cachedMeta = { ...parsed, __metaPath: metaPath };
    return cachedMeta;
  } catch {
    return null;
  }
}

/**
 * Build a hash → slug index from the sidecar meta. Returns an empty Map
 * when meta is unavailable so the caller still gets a usable shape.
 *
 * @param {object|null} meta
 * @returns {Map<string, string>}
 */
export function buildHashToSlugIndex(meta) {
  const out = new Map();
  if (!meta || !meta.perArticle) return out;
  for (const [slug, entry] of Object.entries(meta.perArticle)) {
    if (entry && typeof entry.hash === 'string') out.set(entry.hash, slug);
  }
  return out;
}

/**
 * Cosine similarity between two equal-length Float32Arrays.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} cosine similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-12 ? 0 : dot / denom;
}

/**
 * Find the top-K most similar published articles to a query vector.
 *
 * @param {Float32Array} queryVec
 * @param {{ store?: object, meta?: object, k?: number }} [opts]
 * @returns {Array<{ slug: string|null, hash: string, cosine: number, index: number }>}
 */
export function findTopK(queryVec, opts = {}) {
  const store = opts.store || loadEmbeddingStore();
  if (!store || !queryVec || queryVec.length === 0) return [];
  if (store.dim !== queryVec.length) return [];

  const k = Math.max(1, opts.k || EMBEDDING_TOP_K);
  const meta = opts.meta !== undefined ? opts.meta : loadEmbeddingMeta();
  const hashToSlug = buildHashToSlugIndex(meta);

  // Heap-free top-K — corpus is ~5k articles, a single linear scan with
  // an O(K log K) re-sort is < 1 ms.
  const sims = new Array(store.count);
  for (let i = 0; i < store.count; i += 1) {
    sims[i] = { index: i, hash: store.hashes[i], cosine: cosineSimilarity(queryVec, store.vectors[i]) };
  }
  sims.sort((a, b) => b.cosine - a.cosine);
  return sims.slice(0, k).map((s) => ({
    slug: hashToSlug.get(s.hash) || null,
    hash: s.hash,
    cosine: s.cosine,
    index: s.index,
  }));
}

/**
 * Reset the per-process cache. Test seam.
 */
export function __resetCache() {
  cachedStore = null;
  cachedMeta = null;
}
