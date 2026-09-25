import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildActiveJobPageInput,
  buildActiveJobPageReuseInput,
  canonicalizeInput,
  computeInputHash,
  relatedArticlesFeedDigest,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const JOBS_SEO_PLUGIN = path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts');

// The bytes the active job template really emits, copied from the renderer's
// shape: `<li class="s-86Qi7h"><a class="s-KkZ9xy" href="…">Title</a></li>`.
// The two feeds differ by ONE link — the same difference deploy 35507082715
// reported on 244 of 244 verified pages.
const feedHtml = (firstSlug: string, firstTitle: string) => (
  '<section class="related s-Duf2at"><h2 class="s-F8Mkz3">Articoli per frontalieri</h2>'
  + '<ul class="s-QkRjp8">'
  + `<li class="s-86Qi7h"><a class="s-KkZ9xy" href="/articoli-frontaliere/${firstSlug}/">${firstTitle}</a></li>`
  + '<li class="s-86Qi7h"><a class="s-KkZ9xy" href="/articoli-frontaliere/comuni-frontiera-ristorni-108-milioni/">Comuni Frontiera Ristorni</a></li>'
  + '</ul></section>'
);

const YESTERDAY_FEED = feedHtml('bollettino-frontaliere-2026-09-19', 'Bollettino Frontaliere 2026-09-19');
const TODAY_FEED = feedHtml('bollettino-frontaliere-2026-09-20', 'Bollettino Frontaliere 2026-09-20');

const JOB = Object.freeze({
  id: 'job-42',
  slug: 'social-worker-psychiatrische-dienste-aargau',
  updatedAt: '2026-09-18T06:00:00.000Z',
  title: 'Social Worker',
  company: 'Psychiatrische Dienste Aargau',
  canton: 'AG',
});

const activeInput = (relatedArticlesHtml: string) => buildActiveJobPageInput({
  job: JOB,
  locale: 'it',
  slug: JOB.slug,
  relatedJobs: [{ id: 'related-1', slug: 'related-1', title: 'Related one' }],
  canonicalJob: JOB,
  canton: 'AG',
  canonicalUrl: `https://frontaliereticino.ch/cerca-lavoro-argovia/${JOB.slug}/`,
  relatedArticlesHtml,
  renderDateBucket: '2026-09-20',
});

const activeHash = (relatedArticlesHtml: string) => computeInputHash(
  activeInput(relatedArticlesHtml),
  'active-job',
);

describe('active job page input carries the related-articles feed', () => {
  it('hashes the same job differently when the related-articles feed moved', () => {
    // The job record, the locale, the slug, the canton, the canonical URL and
    // the build day are IDENTICAL: only the corpus feed published a new
    // article. Before this contract the two hashes were equal, the cached HTML
    // was reused, and the page kept linking yesterday's bulletin.
    expect(activeHash(YESTERDAY_FEED)).not.toBe(activeHash(TODAY_FEED));
  });

  it('keeps the hash stable when the feed did not move', () => {
    expect(activeHash(YESTERDAY_FEED)).toBe(activeHash(YESTERDAY_FEED));
    // A rebuilt-but-equal string must hash identically: the digest is over the
    // bytes, not over object identity.
    expect(activeHash(YESTERDAY_FEED)).toBe(
      activeHash(feedHtml('bollettino-frontaliere-2026-09-19', 'Bollettino Frontaliere 2026-09-19')),
    );
  });

  it('keeps the reuse key stable across feed and build-day changes', () => {
    const yesterday = activeInput(YESTERDAY_FEED);
    const today = activeInput(TODAY_FEED);
    const yesterdayReuse = buildActiveJobPageReuseInput(yesterday);
    const todayReuse = buildActiveJobPageReuseInput({
      ...today,
      renderDateBucket: '2026-09-21',
    });

    expect(computeInputHash(yesterday, 'active-job')).not.toBe(
      computeInputHash(today, 'active-job'),
    );
    expect(yesterdayReuse).not.toHaveProperty('relatedArticlesDigest');
    expect(yesterdayReuse).not.toHaveProperty('renderDateBucket');
    expect(yesterdayReuse).toEqual(todayReuse);
    expect(computeInputHash(yesterdayReuse, 'active-job')).toBe(
      computeInputHash(todayReuse, 'active-job'),
    );
  });

  it('stores a short digest, never the feed itself', () => {
    const canonical = canonicalizeInput(activeInput(YESTERDAY_FEED));
    expect(canonical).toContain('"relatedArticlesDigest"');
    expect(canonical).not.toContain('articoli-frontaliere');
    expect(activeInput(YESTERDAY_FEED).relatedArticlesDigest).toMatch(/^[a-f0-9]{16}$/);
  });

  it('survives the runtime-input key filter that silently drops build metadata', () => {
    // `canonicalValue()` deletes keys like `lastmod`/`generatedAt` from every
    // input. A field named into that set would look present and hash to
    // nothing — assert the digest really reaches the hash.
    const withDigest = canonicalizeInput(activeInput(YESTERDAY_FEED));
    const withOtherDigest = canonicalizeInput(activeInput(TODAY_FEED));
    expect(withDigest).not.toBe(withOtherDigest);
    expect(withDigest).toContain(relatedArticlesFeedDigest(YESTERDAY_FEED));
  });

  it('digests an absent feed without throwing', () => {
    expect(relatedArticlesFeedDigest('')).toBe(relatedArticlesFeedDigest(undefined));
    expect(relatedArticlesFeedDigest('')).not.toBe(relatedArticlesFeedDigest(YESTERDAY_FEED));
  });
});

describe('jobsSeoPagesPlugin wires the feed the renderer actually emits', () => {
  const source = fs.readFileSync(JOBS_SEO_PLUGIN, 'utf8');

  it('feeds the active page input with the memoized rendered block', () => {
    expect(source).toContain('const recentArticlesHtml = recentArticlesHtmlFor(locale);');
    expect(source).toContain('relatedArticlesHtml: recentArticlesHtml,');
    expect(source).toContain('buildActiveJobPageReuseInput(activeJobManifestInput)');
    expect(source).toContain('buildActiveJobPageInput({');
  });

  it('does not widen the other reuse blocks with a feed they never render', () => {
    // `recentArticlesHtmlFor` has exactly one call site: the active page loop.
    // The expired-soft-landing, previous-slug-legacy
    // and cross-locale-reconciliation templates never render the block, so
    // adding the digest to their inputs would cost reuse for nothing.
    const callSites = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => line.includes('recentArticlesHtmlFor(locale)'));
    expect(callSites).toHaveLength(1);
    expect(source.match(/relatedArticlesHtml:/g) || []).toHaveLength(1);
  });
});
