/**
 * Emits `virtual:seo-blog-shard-index` — a `blog-<id> → shard ordinal` map built by
 * reading the `seo-blog*.ts` sources at build time.
 *
 * `services/seoService.ts` dynamically imports it so `getSeoEntry('blog-…')` can fetch
 * the ONE shard that owns the key instead of all eight. Measured on the article
 * `/articoli-frontaliere/spese-bancarie-titoli-frontalieri/`: the eight shards cost
 * 956 KB transferred; the owning shard plus this index costs ~370 KB.
 *
 * VIRTUAL, NOT COMMITTED, on purpose. The shard files are corpus content — symlinks
 * into `packages/articles/content/seo/`, appended by `scripts/create-article.mjs` and
 * refreshed by the mirror. A generated file checked into the repo would go stale every
 * time an article lands and would have to be regenerated in the same commit. Deriving
 * it during the build makes drift unrepresentable.
 *
 * FAIL-OPEN. If a shard can't be read the plugin warns and omits its keys rather than
 * failing the build: a missing entry makes the runtime fall back to loading every
 * shard, which is the pre-existing behaviour. An SEO-critical path must degrade to
 * "slow but correct", never to "fast and wrong".
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  BLOG_SEO_SHARD_IDS,
  blogSeoShardSourcePath,
  buildBlogSeoShardIndex,
  extractTopLevelSeoKeys,
  type BlogSeoShardId,
} from './shared/blogSeoShards';

export const SEO_BLOG_SHARD_INDEX_ID = 'virtual:seo-blog-shard-index';
/**
 * Rollup's module id for the virtual module. Exported so `vite.config.ts` can name
 * the emitted chunk in `manualChunks`: left alone, Rollup derives the filename from
 * this id and emits `_virtual_seo-blog-shard-index.js`. Filenames here are STABLE
 * (no content hash) and therefore permanent public URLs, so the bundler's internal
 * `\0virtual:` spelling should not end up in one.
 */
export const RESOLVED_SEO_BLOG_SHARD_INDEX_ID = `\0${SEO_BLOG_SHARD_INDEX_ID}`;
const RESOLVED_ID = RESOLVED_SEO_BLOG_SHARD_INDEX_ID;

/** Read every shard and return its top-level keys. Unreadable shards yield []. */
export function collectBlogSeoShardKeys(
  rootDir: string,
  warn: (msg: string) => void = (m) => console.warn(m),
): Map<BlogSeoShardId, string[]> {
  const byShard = new Map<BlogSeoShardId, string[]>();
  for (const id of BLOG_SEO_SHARD_IDS) {
    const file = np.resolve(rootDir, blogSeoShardSourcePath(id));
    try {
      const keys = extractTopLevelSeoKeys(fs.readFileSync(file, 'utf-8'));
      if (keys.length === 0) warn(`[seo-blog-index] ${blogSeoShardSourcePath(id)} yielded 0 keys — shard will load via fallback`);
      byShard.set(id, keys);
    } catch {
      warn(`[seo-blog-index] could not read ${blogSeoShardSourcePath(id)} — its keys fall back to the load-all path`);
      byShard.set(id, []);
    }
  }
  return byShard;
}

/** Build the index map for `rootDir`. Exported for tests. */
export function buildSeoBlogShardIndex(
  rootDir: string,
  warn?: (msg: string) => void,
): Record<string, number> {
  return buildBlogSeoShardIndex(collectBlogSeoShardKeys(rootDir, warn));
}

export function seoBlogShardIndexPlugin(rootDir: string): Plugin {
  let cached: string | null = null;

  return {
    name: 'seo-blog-shard-index',
    // Reset between watch-mode rebuilds so an appended article is picked up.
    buildStart() {
      cached = null;
    },
    resolveId(id) {
      if (id === SEO_BLOG_SHARD_INDEX_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      if (cached) return cached;
      const index = buildSeoBlogShardIndex(rootDir, (m) => this.warn(m));
      const count = Object.keys(index).length;
      console.log(`[seo-blog-index] ${count} blog SEO keys mapped across ${BLOG_SEO_SHARD_IDS.length} shards`);
      // A plain object literal, not a packed string: it is ~46 KB gzip either way
      // (the shared `blog-` prefix compresses out), and this form is readable in
      // devtools when an article's metadata goes missing.
      cached = `export default ${JSON.stringify(index)};\n`;
      return cached;
    },
  };
}

export default seoBlogShardIndexPlugin;
