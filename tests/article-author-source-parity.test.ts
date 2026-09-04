/**
 * `article:author` parity between the two independent author sources.
 *
 * Follow-up of #7227 (issue #7241 item 1). That PR fixed the tag itself: the SSG
 * emitted `/chi-siamo/` for every article, so guest-authored ones were attributed
 * to the Redazione by every OG consumer. What it did NOT remove is the structural
 * cause — the same fact is stored twice, in two places nothing compares:
 *
 *   - SSG  — `packages/articles/engine/ogPagesPlugin.ts` derives the author from
 *            `authorSlug` (registry field in `data/blog-articles-data.ts`) resolved
 *            against `data/authors.ts`, falling back to the Organization when unset.
 *   - SPA  — `services/seoService.ts` reads `structuredData.author` verbatim out of
 *            the generated `content/seo/seo-blog*.ts` blobs, falling back to
 *            `/chi-siamo/` when that node is not a `Person` with a `url`.
 *
 * Measured when this gate was first run: they did NOT agree — 1712 of the 3692 articles
 * carried a real `authorSlug` while their blob still held the legacy
 * `{"@id": …#organization}` node, so the SPA overwrote the correct static tag with
 * `/chi-siamo/`. The fix collapses the two sources into one: `seoService.ts` now
 * derives from the registry through `services/seo/articleAuthorUrl.ts` and keeps the
 * blob as a fallback only. This suite is the gate that keeps them collapsed — it
 * exercises the real derivation both surfaces implement, so a future change that
 * lets the blob win again (or that moves one surface's URL shape) fails here.
 *
 * Reads the blobs as TEXT via `extractSeoAuthorRefs`: importing the eight shards
 * would pull ~11 MB of generated TypeScript into the runner for two fields per entry.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTICLES } from '@/data/blog-articles-data';
import { AUTHORS, getAuthorBySlug } from '@/data/authors';
import { resolveArticleAuthorUrl, ORG_AUTHOR_URL, authorPageUrl } from '@/services/seo/articleAuthorUrl';
import {
  BLOG_SEO_SHARD_IDS,
  blogSeoShardSourcePath,
  extractSeoAuthorRefs,
  type SeoShardAuthorRef,
} from '../build-plugins/shared/blogSeoShards';

const ROOT = path.resolve(__dirname, '..');

/**
 * Later shards win, mirroring the spread merge `loadBlogSeoEntry()` replays —
 * 983 keys are defined in two shards, so folding in any other order would compare
 * a record the runtime never serves.
 */
const authorRefsByKey = ((): Map<string, SeoShardAuthorRef> => {
  const merged = new Map<string, SeoShardAuthorRef>();
  for (const id of BLOG_SEO_SHARD_IDS) {
    const file = path.join(ROOT, blogSeoShardSourcePath(id));
    if (!fs.existsSync(file)) continue;
    for (const [key, ref] of extractSeoAuthorRefs(fs.readFileSync(file, 'utf-8'))) {
      merged.set(key, ref);
    }
  }
  return merged;
})();

/**
 * What `ogPagesPlugin.ts` puts in `article:author` (its `authorObj.url`), spelled
 * out here rather than imported: the engine package resolves `getAuthorBySlug`
 * through the shell bootstrap and cannot be called from a test without a build.
 * If that branch changes, this literal must change with it — which is the point.
 */
function ssgAuthorUrl(authorSlug?: string): string {
  const resolved = authorSlug ? getAuthorBySlug(authorSlug) : undefined;
  return resolved ? authorPageUrl(resolved.slug) : ORG_AUTHOR_URL;
}

/** What `seoService.ts` puts in `article:author` for the same article. */
function spaAuthorUrl(article: { authorSlug?: string }, ref: SeoShardAuthorRef | undefined): string {
  return resolveArticleAuthorUrl(article, { '@type': ref?.type, url: ref?.url });
}

const summarize = (offenders: readonly string[]): string =>
  `\n${offenders.slice(0, 25).join('\n')}${offenders.length > 25 ? `\n  … +${offenders.length - 25} more` : ''}`;

describe('article:author — dual source-of-truth parity', () => {
  it('the shard blobs are readable (guards the extractor itself)', () => {
    // A silently empty map would make every parity assertion below pass for the
    // wrong reason — the failure mode of a text scanner whose input format moved.
    expect(authorRefsByKey.size).toBeGreaterThan(100);
  });

  it('SSG and SPA derive the same article:author URL for every article', () => {
    const offenders: string[] = [];
    let compared = 0;
    for (const article of ARTICLES) {
      const ref = authorRefsByKey.get(`blog-${article.id}`);
      if (!ref) continue; // no SEO blob entry → the SPA never reads one for this id
      compared++;
      const ssg = ssgAuthorUrl(article.authorSlug);
      const spa = spaAuthorUrl(article, ref);
      if (ssg !== spa) {
        offenders.push(
          `  - ${article.id}: SSG "${ssg}" (authorSlug=${JSON.stringify(article.authorSlug)}) ` +
            `≠ SPA "${spa}" (content/seo structuredData.author)`,
        );
      }
    }
    // The `continue` above is the vacuity hole: if the blob key format ever moves
    // away from `blog-<id>`, every article skips and the assertion below passes
    // having compared nothing. 3692 of 3736 articles match today (the rest have no
    // blob entry); a floor well under that catches the format break without
    // failing on the ordinary drip of new articles.
    expect(
      compared,
      `only ${compared} article(s) matched a content/seo entry by \`blog-<id>\` — the parity ` +
        `assertion below would be vacuous. Check the shard key format against ARTICLES[].id.`,
    ).toBeGreaterThan(3000);
    expect(
      offenders.length,
      `${offenders.length} article(s) would emit a different article:author on the static page than ` +
        `on the SPA side. Both must derive from authorSlug + data/authors.ts — check whether one ` +
        `surface went back to reading content/seo/**:${summarize(offenders)}`,
    ).toBe(0);
  });

  it('every Person author in the SEO blobs resolves to the authors registry', () => {
    // The other direction of the same drift: a blob naming an author page that the
    // registry no longer serves emits `article:author` pointing at a 404.
    const knownAuthorUrls = new Set(
      AUTHORS.map((a) => authorPageUrl(a.slug)).concat(
      ARTICLES.flatMap((a) => {
        const author = a.authorSlug ? getAuthorBySlug(a.authorSlug) : undefined;
        return author ? [authorPageUrl(author.slug)] : [];
      })),
    );
    const offenders: string[] = [];
    for (const [key, ref] of authorRefsByKey) {
      if (ref.type !== 'Person' || !ref.url) continue;
      if (ref.url === ORG_AUTHOR_URL) continue; // Organization-equivalent legacy form
      if (!knownAuthorUrls.has(ref.url)) offenders.push(`  - ${key}: author url "${ref.url}"`);
    }
    expect(
      offenders.length,
      `${offenders.length} SEO blob entr(y/ies) name an author page the registry does not serve ` +
        `— the fallback branch would emit a 404 URL:${summarize(offenders)}`,
    ).toBe(0);
  });
});
