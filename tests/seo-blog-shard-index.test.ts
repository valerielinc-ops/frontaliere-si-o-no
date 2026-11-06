/**
 * Guards the `seo-blog` shard index — the artifact that lets an article page fetch
 * ONE seo-blog chunk instead of all eight.
 *
 * The stakes are asymmetric and that shapes what is asserted here. A wrong or missing
 * mapping is only a performance regression: `loadBlogSeoEntry()` falls back to loading
 * every shard, which is what the code did before. What must never happen is the index
 * pointing a key at a shard that does NOT contain it while the caller trusts the
 * answer — that would blank the title/canonical/JSON-LD of the site's main SEO
 * surface. So the tests below check containment and precedence, not just counts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOG_SEO_SHARD_IDS,
  blogSeoShardSourcePath,
  buildBlogSeoShardIndex,
  extractTopLevelSeoKeys,
  type BlogSeoShardId,
} from '../build-plugins/shared/blogSeoShards';
import { buildSeoBlogShardIndex, collectBlogSeoShardKeys } from '../build-plugins/seoBlogShardIndexPlugin';

const ROOT = path.resolve(__dirname, '..');

describe('extractTopLevelSeoKeys', () => {
  it('takes depth-1 keys and ignores everything nested', () => {
    const src = `
      const M: Record<string, SEOMetadata> = {
        'blog-alpha': {
          title: 'A',
          structuredData: { '@type': 'NewsArticle', headline: 'H', image: { url: 'u' } },
        },
        'blog-beta': { title: 'B', keywords: 'k' },
      };
    `;
    expect(extractTopLevelSeoKeys(src)).toEqual(['blog-alpha', 'blog-beta']);
  });

  it('is not derailed by braces inside strings, template interpolations or comments', () => {
    // Every construct here appears verbatim in the generated shards: `${BASE_URL}`
    // interpolations inside image URLs, `//` inside https:// literals, and prose
    // containing braces.
    const src = `
      const M: Record<string, SEOMetadata> = {
        // 'blog-commented-out': { title: 'nope' },
        'blog-real': {
          description: 'un { non chiuso e uno } spaiato',
          canonicalPath: 'https://example.test/a/b/',
          image: { url: \`\${BASE_URL}/images/blog/x.webp\`, caption: "a \\" quote" },
          /* 'blog-block-commented': { } */
        },
        'blog-second': { title: 'ok' },
      };
    `;
    expect(extractTopLevelSeoKeys(src)).toEqual(['blog-real', 'blog-second']);
  });

  it('returns [] instead of throwing when there is no record declaration', () => {
    expect(extractTopLevelSeoKeys('export const nothing = 1;')).toEqual([]);
  });
});

describe('shard registry', () => {
  it('lists every seo-blog*.ts that exists on disk', () => {
    // Catches the rollover case: create-article.mjs opens seo-blog-8.ts, nobody
    // updates BLOG_SEO_SHARD_IDS, and 300 articles quietly resolve via fallback.
    const dir = path.join(ROOT, 'services', 'seo');
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => /^seo-blog(-[a-z0-9]+)?\.ts$/.test(f))
      .sort();
    const listed = BLOG_SEO_SHARD_IDS.map((id) => `seo-${id}.ts`).sort();
    expect(listed).toEqual(onDisk);
  });

  it('has a literal loader in seoService for every shard id', () => {
    // The specifiers must be literal for Rollup to code-split them, so this is a
    // source-level check rather than an import of module-private state.
    const src = fs.readFileSync(path.join(ROOT, 'services', 'seoService.ts'), 'utf-8');
    for (const id of BLOG_SEO_SHARD_IDS) {
      expect(src, `missing loader for shard ${id}`).toContain(`import('./seo/seo-${id}')`);
    }
  });
});

describe('index built from the real corpus', () => {
  const keysByShard = collectBlogSeoShardKeys(ROOT, () => {});
  const index = buildSeoBlogShardIndex(ROOT, () => {});

  it('extracts a plausible number of keys from every shard', () => {
    for (const id of BLOG_SEO_SHARD_IDS) {
      expect(keysByShard.get(id)!.length, `shard ${id} yielded no keys`).toBeGreaterThan(0);
    }
    expect(Object.keys(index).length).toBeGreaterThan(3000);
  });

  it('only extracts blog-* keys', () => {
    const stray = Object.keys(index).filter((k) => !k.startsWith('blog-'));
    expect(stray).toEqual([]);
  });

  it('points every key at a shard whose source actually defines it', () => {
    // The load-bearing invariant. Sampled rather than exhaustive: a full check means
    // ~3.7k substring scans over 11 MB of source, and the sample plus the
    // containment logic below is enough to catch a systematic off-by-one.
    const sources = new Map<BlogSeoShardId, string>(
      BLOG_SEO_SHARD_IDS.map((id) => [id, fs.readFileSync(path.join(ROOT, blogSeoShardSourcePath(id)), 'utf-8')]),
    );
    const keys = Object.keys(index);
    const step = Math.max(1, Math.floor(keys.length / 400));
    for (let i = 0; i < keys.length; i += step) {
      const key = keys[i];
      const id = BLOG_SEO_SHARD_IDS[index[key]];
      expect(sources.get(id), `${key} mapped to ${id}, which does not define it`).toContain(`'${key}':`);
    }
  });

  it('resolves a key defined in two shards to the LAST one, matching the spread merge', () => {
    // 983 keys are duplicated across shards. loadBlogSeoChunk merges with
    // `{ ...blog, ...blog-2, … }`, so the later shard wins; single-shard routing has
    // to reproduce that or a duplicated article silently gets its stale record.
    //
    // Audited 2026-08-07: 982 of those 983 carry byte-identical records, so
    // precedence is unobservable for them. Exactly ONE differs —
    // `blog-laghi-lombardi-sicurezza-estate-2026` (seo-blog vs seo-blog-5) — which is
    // the single article where getting this order wrong would actually change the
    // rendered title/description. It is covered by the loop below.
    const seen = new Map<string, BlogSeoShardId[]>();
    for (const id of BLOG_SEO_SHARD_IDS) {
      for (const k of keysByShard.get(id)!) {
        if (!seen.has(k)) seen.set(k, []);
        seen.get(k)!.push(id);
      }
    }
    const duplicated = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    expect(duplicated.length, 'expected the corpus to still contain cross-shard duplicates').toBeGreaterThan(0);
    for (const [key, ids] of duplicated) {
      const last = ids[ids.length - 1];
      expect(BLOG_SEO_SHARD_IDS[index[key]], `${key} should resolve to ${last}`).toBe(last);
    }
  });
});

describe('buildBlogSeoShardIndex', () => {
  it('lets later shards overwrite earlier ones', () => {
    const map = new Map<BlogSeoShardId, string[]>([
      ['blog', ['blog-x', 'blog-y']],
      ['blog-5', ['blog-x']],
    ]);
    const index = buildBlogSeoShardIndex(map);
    expect(BLOG_SEO_SHARD_IDS[index['blog-x']]).toBe('blog-5');
    expect(BLOG_SEO_SHARD_IDS[index['blog-y']]).toBe('blog');
  });

  it('tolerates shards with no keys', () => {
    expect(buildBlogSeoShardIndex(new Map())).toEqual({});
  });
});
