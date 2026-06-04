#!/usr/bin/env node
// Incremental embedding builder.
//
// Output:
//   data/article-embeddings.bin       — packed binary store (Float32 vectors)
//   data/article-embeddings-meta.json — sidecar JSON for human-debuggability
//
// File format:
//   Header (32 bytes): magic "EMBV1\0\0\0" (8B) + count uint32 LE (4B)
//                    + dim uint32 LE (4B) + reserved (16B)
//   Records: per-article 32-byte slug-hash + (dim × 4-byte float32) payload
//
// Incremental strategy: read existing file, build set of slug-hashes; only
// embed articles whose hash isn't already present. Atomic rename on commit.

import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedBatch, lastUsedEmbeddingModel } from './lib/evidence/embeddingClient.mjs';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './lib/evidence/constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_BIN = resolve(REPO_ROOT, 'data/article-embeddings.bin');
const OUTPUT_META = resolve(REPO_ROOT, 'data/article-embeddings-meta.json');
const BLOG_META_IT = resolve(REPO_ROOT, 'services/locales/blog-meta-it.ts');

const MAGIC = Buffer.from('EMBV1\0\0\0', 'binary');
const HEADER_BYTES = 32;
const HASH_BYTES = 32;
const RECORD_PAYLOAD_BYTES = EMBEDDING_DIM * 4;
const RECORD_BYTES = HASH_BYTES + RECORD_PAYLOAD_BYTES;
const BATCH_SIZE = 100;

/**
 * Slug hash (32 bytes) — SHA-256 of the slug string. Used as a stable key
 * across incremental builds even if the slug→headline mapping changes.
 */
function slugHashBuffer(slug) {
  return createHash('sha256').update(slug, 'utf8').digest();
}

/**
 * Parse `services/locales/blog-meta-it.ts` and return the
 * `Map<slug, { title, excerpt }>` we'll feed into the embedder.
 */
function loadArticles() {
  if (!existsSync(BLOG_META_IT)) return new Map();
  const text = readFileSync(BLOG_META_IT, 'utf8');
  const reKey = /'(blog\.article\.([a-z0-9-]+)\.(title|excerpt))': '((?:\\'|[^'])*)'/g;
  const articles = new Map();
  let m;
  while ((m = reKey.exec(text)) !== null) {
    const slug = m[2];
    const field = m[3];
    const value = m[4].replace(/\\'/g, "'");
    if (!articles.has(slug)) articles.set(slug, { title: '', excerpt: '' });
    articles.get(slug)[field] = value;
  }
  return articles;
}

/**
 * Read the existing .bin (if any). Returns:
 *   { hashes: Map<hex, { byteOffset, vector }>, dim, count }
 * Throws if the file is corrupt or has a different dim.
 */
function readExistingStore() {
  if (!existsSync(OUTPUT_BIN)) {
    return { hashes: new Map(), dim: EMBEDDING_DIM, count: 0 };
  }
  const buf = readFileSync(OUTPUT_BIN);
  if (buf.length < HEADER_BYTES) throw new Error('embedding store too small for header');
  const magic = buf.subarray(0, 8);
  if (!magic.equals(MAGIC)) throw new Error('embedding store has bad magic');
  const count = buf.readUInt32LE(8);
  const dim = buf.readUInt32LE(12);
  if (dim !== EMBEDDING_DIM) throw new Error(`existing dim=${dim} != ${EMBEDDING_DIM}`);
  const expectedSize = HEADER_BYTES + count * (HASH_BYTES + dim * 4);
  if (buf.length !== expectedSize) {
    throw new Error(`embedding store size mismatch: got ${buf.length}, expected ${expectedSize}`);
  }
  const hashes = new Map();
  let off = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const hashHex = buf.subarray(off, off + HASH_BYTES).toString('hex');
    hashes.set(hashHex, { byteOffset: off, vectorOffset: off + HASH_BYTES });
    off += HASH_BYTES + dim * 4;
  }
  return { hashes, dim, count, buf };
}

function buildHeader(count) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(EMBEDDING_DIM, 12);
  // bytes 16..31 reserved (zeroed).
  return header;
}

// Exported so the semantic-dedup gate's `buildDedupText` can be asserted
// byte-identical against it (tests/scripts/lib/scoring/dedupTextSync.test.ts):
// the two must produce the same corpus text or the published-vs-candidate
// cosines drift and the gate degrades to silent false-negatives.
export function articleText(article) {
  const title = article.title || '';
  const excerpt = article.excerpt || '';
  // Title + first 800 chars of excerpt (proxy for body when full body isn't loaded).
  return `${title}\n\n${excerpt}`.slice(0, 4000);
}

async function main() {
  const args = process.argv.slice(2);
  const isIncremental = args.includes('--incremental');
  const isFullRebuild = args.includes('--full');

  const articles = loadArticles();
  if (articles.size === 0) {
    console.error('EMBEDDINGS_BUILD no articles found in blog-meta-it.ts — exiting');
    process.exit(0);
  }

  let existingStore = { hashes: new Map(), dim: EMBEDDING_DIM, count: 0, buf: null };
  if (!isFullRebuild) {
    try {
      existingStore = readExistingStore();
    } catch (err) {
      console.error(`EMBEDDINGS_BUILD existing store unreadable, full rebuild: ${err.message}`);
      existingStore = { hashes: new Map(), dim: EMBEDDING_DIM, count: 0, buf: null };
    }
  }

  // Provider-drift guard. The persisted .bin vectors live in ONE model's vector
  // space (mistral-embed vs embed-multilingual-v3.0 — same dim=1024, DIFFERENT
  // spaces). If the active provider has drifted from the model that built the
  // store (e.g. MISTRAL_API_KEY revoked → Cohere fallback), appending new
  // vectors would silently mix incompatible spaces and corrupt every downstream
  // cosine. Probe the active model with a tiny embed; if it differs from the
  // store's meta.model, discard the preserved vectors and re-embed the whole
  // corpus with the active provider so the store stays single-model.
  let existingStoreModel = null;
  if (!isFullRebuild && existsSync(OUTPUT_META)) {
    try {
      const m = JSON.parse(readFileSync(OUTPUT_META, 'utf8'));
      if (m && typeof m.model === 'string') existingStoreModel = m.model;
    } catch { /* unreadable meta → treat as unknown, no drift forcing */ }
  }
  let forceFullReembed = isFullRebuild;
  if (!forceFullReembed && existingStore.count > 0 && existingStoreModel) {
    try {
      await embedBatch({ inputs: ['__provider_probe__'] });
      const activeModel = lastUsedEmbeddingModel();
      if (activeModel && activeModel !== existingStoreModel) {
        console.error(`EMBEDDINGS_BUILD provider drift: store='${existingStoreModel}' active='${activeModel}' — discarding preserved vectors and re-embedding full corpus (cross-model cosine would be invalid).`);
        forceFullReembed = true;
        existingStore = { hashes: new Map(), dim: EMBEDDING_DIM, count: 0, buf: null };
      }
    } catch (err) {
      // Probe failed (e.g. all providers down) — leave incremental as-is; the
      // real embed loop below will surface the error. Do not corrupt the store.
      console.error(`EMBEDDINGS_BUILD provider probe failed (continuing incremental): ${err.message}`);
    }
  }

  // Build per-slug records: existing first (preserved verbatim), then new.
  const records = [];
  const perArticle = {};

  // Re-emit existing entries we still need (slug present in articles map).
  for (const [slug] of articles) {
    const hashBuf = slugHashBuffer(slug);
    const hashHex = hashBuf.toString('hex');
    if (existingStore.hashes.has(hashHex) && existingStore.buf) {
      const ent = existingStore.hashes.get(hashHex);
      const payload = existingStore.buf.subarray(ent.vectorOffset, ent.vectorOffset + RECORD_PAYLOAD_BYTES);
      records.push({ hashBuf, payload, slug });
      perArticle[slug] = { hash: hashHex, byteOffset: 0 }; // offsets fixed up after sort
    }
  }

  // Identify new (uncached) articles. On a forced full re-embed (explicit
  // --full, or provider drift detected above) every article is re-embedded.
  const toEmbed = [];
  for (const [slug, art] of articles) {
    const hashHex = slugHashBuffer(slug).toString('hex');
    if (!existingStore.hashes.has(hashHex) || forceFullReembed) {
      toEmbed.push({ slug, text: articleText(art) });
    }
  }

  if (toEmbed.length > 0) {
    const hasMistral = !!(process.env.MISTRAL_API_KEY || '').trim();
    const hasCohere = !!(process.env.COHERE_API_KEY || '').trim();
    if (!hasMistral && !hasCohere) {
      console.error(`EMBEDDINGS_BUILD skipped — no embedding provider configured (set MISTRAL_API_KEY or COHERE_API_KEY in Remote Config). ${toEmbed.length} articles would have been embedded; cascadedScore will fall through to cluster median for unembedded articles.`);
      const meta = {
        // Preserve the untouched store's own model label (don't relabel a store
        // we didn't rebuild). Fall back to EMBEDDING_MODEL only if unknown.
        model: existingStoreModel || EMBEDDING_MODEL,
        dim: EMBEDDING_DIM,
        count: existingStore.count,
        builtAt: new Date().toISOString(),
        skipped: 'no provider key in env',
      };
      writeFileSync(OUTPUT_META, JSON.stringify(meta, null, 2) + '\n');
      console.error(`EMBEDDINGS_BUILD wrote meta-only sidecar at ${OUTPUT_META}`);
      return;
    }
    console.error(`EMBEDDINGS_BUILD embedding ${toEmbed.length} new articles (incremental=${isIncremental || !isFullRebuild})`);
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const vectors = await embedBatch({ inputs: batch.map((b) => b.text) });
      for (let j = 0; j < batch.length; j++) {
        const slug = batch[j].slug;
        const hashBuf = slugHashBuffer(slug);
        const payload = Buffer.from(vectors[j].buffer, vectors[j].byteOffset, RECORD_PAYLOAD_BYTES);
        records.push({ hashBuf, payload, slug });
        perArticle[slug] = { hash: hashBuf.toString('hex'), byteOffset: 0 };
      }
      console.error(`EMBEDDINGS_BUILD batch ${i / BATCH_SIZE + 1} done (${batch.length} vectors)`);
    }
  } else {
    console.error('EMBEDDINGS_BUILD no new articles to embed');
  }

  // Sort records by slug so file ordering is deterministic across runs.
  records.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const count = records.length;
  const totalSize = HEADER_BYTES + count * RECORD_BYTES;
  const out = Buffer.alloc(totalSize);
  buildHeader(count).copy(out, 0);
  let off = HEADER_BYTES;
  for (const rec of records) {
    rec.hashBuf.copy(out, off);
    perArticle[rec.slug].byteOffset = off;
    rec.payload.copy(out, off + HASH_BYTES);
    off += RECORD_BYTES;
  }

  mkdirSync(dirname(OUTPUT_BIN), { recursive: true });
  const tmpBin = `${OUTPUT_BIN}.tmp`;
  writeFileSync(tmpBin, out);
  renameSync(tmpBin, OUTPUT_BIN);

  // Record the model that ACTUALLY produced the vectors in this store, not a
  // hardcoded default. After a provider drift / fallback the store is rebuilt in
  // the active provider's space; meta.model must reflect that so the read-side
  // guard (embeddingMatcher.findTopK) can detect future drift. If nothing was
  // embedded this run (incremental no-op), keep the prior label.
  const builtModel = lastUsedEmbeddingModel() || existingStoreModel || EMBEDDING_MODEL;
  const meta = {
    model: builtModel,
    dim: EMBEDDING_DIM,
    count,
    builtAt: new Date().toISOString(),
    perArticle,
  };
  const tmpMeta = `${OUTPUT_META}.tmp`;
  writeFileSync(tmpMeta, JSON.stringify(meta, null, 2));
  renameSync(tmpMeta, OUTPUT_META);

  console.error(`EMBEDDINGS_BUILD_DONE count=${count} bytes=${totalSize}`);
  process.exit(0);
}

// Only run the builder when executed directly (`node build-article-embeddings.mjs`),
// not when imported — tests import `articleText` and must not trigger main().
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('EMBEDDINGS_BUILD_UNCAUGHT', err);
    process.exit(1);
  });
}
