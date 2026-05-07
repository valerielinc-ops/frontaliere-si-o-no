// tests/scripts/lib/scoring/embeddingMatcher.test.ts
//
// Phase 2 — embedding-store reader + cosine top-K. Spec § 5.5.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  cosineSimilarity,
  loadEmbeddingStore,
  loadEmbeddingMeta,
  buildHashToSlugIndex,
  findTopK,
  __resetCache,
} from '../../../../scripts/lib/scoring/embeddingMatcher.mjs';

const HEADER_BYTES = 32;
const HASH_BYTES = 32;
const TEST_DIM = 4; // small dim to keep fixtures tractable.

let workDir: string;
let binPath: string;
let metaPath: string;

function slugHash(slug: string): Buffer {
  return createHash('sha256').update(slug, 'utf8').digest();
}

/**
 * Build a binary embedding store with `count` records of dim `dim`.
 * Mirrors the format produced by scripts/build-article-embeddings.mjs:
 *   header (32B): "EMBV1\0\0\0" + count (uint32 LE) + dim (uint32 LE) + 16B reserved
 *   per record: 32B sha256 slug-hash + dim*4B float32 payload
 */
function writeStore(slugs: string[], vectors: number[][], dim: number): { perArticle: Record<string, { hash: string; byteOffset: number }> } {
  const count = slugs.length;
  const recordBytes = HASH_BYTES + dim * 4;
  const total = HEADER_BYTES + count * recordBytes;
  const buf = Buffer.alloc(total);
  Buffer.from('EMBV1\0\0\0', 'binary').copy(buf, 0);
  buf.writeUInt32LE(count, 8);
  buf.writeUInt32LE(dim, 12);
  let off = HEADER_BYTES;
  const perArticle: Record<string, { hash: string; byteOffset: number }> = {};
  for (let i = 0; i < count; i += 1) {
    const hash = slugHash(slugs[i]);
    hash.copy(buf, off);
    perArticle[slugs[i]] = { hash: hash.toString('hex'), byteOffset: off };
    const payload = Float32Array.from(vectors[i]);
    Buffer.from(payload.buffer, payload.byteOffset, dim * 4).copy(buf, off + HASH_BYTES);
    off += recordBytes;
  }
  writeFileSync(binPath, buf);
  const meta = { model: 'test', dim, count, builtAt: new Date().toISOString(), perArticle };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { perArticle };
}

beforeEach(() => {
  workDir = join(tmpdir(), `emb-matcher-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  binPath = join(workDir, 'embeddings.bin');
  metaPath = join(workDir, 'embeddings-meta.json');
  __resetCache();
});

afterEach(() => {
  __resetCache();
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = Float32Array.from([1, 0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0, 0, 0]);
    const b = Float32Array.from([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns 0 for null/empty inputs', () => {
    expect(cosineSimilarity(null as unknown as Float32Array, Float32Array.from([1]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([]), Float32Array.from([]))).toBe(0);
  });

  it('returns 0 for mismatched dimensions', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('loadEmbeddingStore', () => {
  it('returns null when file is missing', () => {
    expect(loadEmbeddingStore({ binPath: join(workDir, 'missing.bin'), force: true })).toBeNull();
  });

  it('reads a well-formed store', () => {
    writeStore(['alpha', 'beta'], [[1, 0, 0, 0], [0, 1, 0, 0]], TEST_DIM);
    const store = loadEmbeddingStore({ binPath, force: true });
    expect(store).not.toBeNull();
    expect(store!.count).toBe(2);
    expect(store!.dim).toBe(TEST_DIM);
    expect(store!.vectors).toHaveLength(2);
    expect(Array.from(store!.vectors[0])).toEqual([1, 0, 0, 0]);
    expect(Array.from(store!.vectors[1])).toEqual([0, 1, 0, 0]);
  });

  it('returns null on bad magic', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    Buffer.from('XXXXX\0\0\0').copy(buf, 0);
    writeFileSync(binPath, buf);
    expect(loadEmbeddingStore({ binPath, force: true })).toBeNull();
  });

  it('returns null on size mismatch', () => {
    const buf = Buffer.alloc(HEADER_BYTES + 5); // truncated
    Buffer.from('EMBV1\0\0\0').copy(buf, 0);
    buf.writeUInt32LE(1, 8);
    buf.writeUInt32LE(TEST_DIM, 12);
    writeFileSync(binPath, buf);
    expect(loadEmbeddingStore({ binPath, force: true })).toBeNull();
  });
});

describe('loadEmbeddingMeta + buildHashToSlugIndex', () => {
  it('returns null when meta file is missing', () => {
    expect(loadEmbeddingMeta({ metaPath: join(workDir, 'missing.json'), force: true })).toBeNull();
  });

  it('builds a hash → slug index from meta', () => {
    writeStore(['alpha', 'beta'], [[1, 0, 0, 0], [0, 1, 0, 0]], TEST_DIM);
    const meta = loadEmbeddingMeta({ metaPath, force: true });
    const idx = buildHashToSlugIndex(meta);
    expect(idx.size).toBe(2);
    const alphaHash = slugHash('alpha').toString('hex');
    expect(idx.get(alphaHash)).toBe('alpha');
  });

  it('empty index when meta is null', () => {
    const idx = buildHashToSlugIndex(null);
    expect(idx.size).toBe(0);
  });
});

describe('findTopK', () => {
  it('returns top-K by cosine similarity', () => {
    writeStore(
      ['alpha', 'beta', 'gamma'],
      [[1, 0, 0, 0], [0, 1, 0, 0], [0.9, 0.1, 0, 0]],
      TEST_DIM,
    );
    const store = loadEmbeddingStore({ binPath, force: true });
    const meta = loadEmbeddingMeta({ metaPath, force: true });
    const query = Float32Array.from([1, 0, 0, 0]);
    const top = findTopK(query, { store: store!, meta, k: 2 });
    expect(top).toHaveLength(2);
    expect(top[0].slug).toBe('alpha');
    expect(top[0].cosine).toBeCloseTo(1, 5);
    expect(top[1].slug).toBe('gamma');
  });

  it('returns [] when store is null', () => {
    const top = findTopK(Float32Array.from([1, 0, 0, 0]), { store: null as any, meta: null });
    expect(top).toEqual([]);
  });

  it('returns [] when query dim mismatches store dim', () => {
    writeStore(['alpha'], [[1, 0, 0, 0]], TEST_DIM);
    const store = loadEmbeddingStore({ binPath, force: true });
    const wrongDim = Float32Array.from([1, 0, 0]);
    const top = findTopK(wrongDim, { store: store!, meta: null });
    expect(top).toEqual([]);
  });
});
