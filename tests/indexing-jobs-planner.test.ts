// @vitest-environment node
/**
 * Google Indexing API job planner: what gets notified, in which order, and
 * what is never sent (non-job pages, live pages as URL_DELETED, over budget).
 */
import { describe, expect, it } from 'vitest';
import {
  quotaDayKey,
  isJobDetailCandidate,
  parseSitemapUrlset,
  parseJobSitemapIndex,
  createLedger,
  loadLedger,
  observeSitemap,
  planSubmissions,
  recordOutcome,
  judgeLive,
  spentOn,
  backlogRank,
  DELETE_SHARE,
  GONE_FORGET_DAYS,
} from '../scripts/lib/indexing-jobs-planner.mjs';
import { parseArgs, DAILY_BUDGET } from '../scripts/submit-google-indexing-jobs.js';

const S = 'https://frontaliereticino.ch';
const job = (p: string) => `${S}${p}`;

describe('quotaDayKey', () => {
  it('uses the Pacific calendar day, which is when the quota resets', () => {
    // 06:10 UTC on the 24th is still the 23rd in Los Angeles (PDT, UTC-7).
    expect(quotaDayKey(new Date('2026-10-24T06:10:00Z'))).toBe('2026-10-23');
    expect(quotaDayKey(new Date('2026-10-24T07:10:00Z'))).toBe('2026-10-24');
  });
});

describe('isJobDetailCandidate', () => {
  it('accepts one slug below a canton job-board section, in every locale', () => {
    expect(isJobDetailCandidate(job('/cerca-lavoro-ticino/farmacista-chiasso-farmacia/'))).toBe(true);
    expect(isJobDetailCandidate(job('/en/find-jobs-zurich/nurse-see-spital/'))).toBe(true);
    expect(isJobDetailCandidate(job('/de/jobs-im-tessin/apotheker-x/'))).toBe(true);
  });
  it('rejects listings, pagination, company hubs, foreign hosts and query strings', () => {
    expect(isJobDetailCandidate(job('/cerca-lavoro-ticino/'))).toBe(false);
    expect(isJobDetailCandidate(job('/cerca-lavoro-zugo/pagina-16/'))).toBe(false);
    expect(isJobDetailCandidate(job('/cerca-lavoro-ticino/azienda-corner-banca/'))).toBe(false);
    expect(isJobDetailCandidate('https://example.com/cerca-lavoro-ticino/x/')).toBe(false);
    expect(isJobDetailCandidate(job('/cerca-lavoro-ticino/x/?a=1'))).toBe(false);
    expect(isJobDetailCandidate(job('/cerca-lavoro-ticino/x'))).toBe(false);
  });
});

describe('sitemap parsing', () => {
  it('reads loc + date-only lastmod and decodes entities', () => {
    const xml = `<urlset><url><loc>${S}/cerca-lavoro-ticino/a-&amp;-b/</loc><lastmod>2026-10-20T10:00:00Z</lastmod></url>
      <url><loc>${S}/cerca-lavoro-ticino/c/</loc></url></urlset>`;
    expect(parseSitemapUrlset(xml)).toEqual([
      { loc: `${S}/cerca-lavoro-ticino/a-&-b/`, lastmod: '2026-10-20' },
      { loc: `${S}/cerca-lavoro-ticino/c/`, lastmod: null },
    ]);
  });
  it('keeps the job sitemap family from the index, never the expired one', () => {
    const idx = ['sitemap-blog.xml', 'sitemap-jobs.xml', 'sitemap-jobs-ticino.xml', 'sitemap-jobs-expired.xml', 'sitemap-job-market.xml']
      .map((f) => `<sitemap><loc>${S}/${f}</loc></sitemap>`).join('');
    expect(parseJobSitemapIndex(idx)).toEqual([`${S}/sitemap-jobs.xml`, `${S}/sitemap-jobs-ticino.xml`]);
  });
});

describe('ledger', () => {
  it('falls back to a fresh ledger on garbage or version mismatch', () => {
    expect(loadLedger('not json', '2026-10-24')).toEqual(createLedger('2026-10-24'));
    expect(loadLedger(JSON.stringify({ version: 999, urls: {} }), '2026-10-24').version).toBe(1);
  });

  it('marks URLs that left the sitemaps and forgets them after the retention window', () => {
    const l = createLedger('2026-10-01');
    observeSitemap(l, [{ loc: job('/cerca-lavoro-ticino/a/'), lastmod: null }], '2026-10-01');
    observeSitemap(l, [], '2026-10-02');
    expect(l.urls[job('/cerca-lavoro-ticino/a/')].gone).toBe('2026-10-02');
    const later = new Date(Date.parse('2026-10-02') + (GONE_FORGET_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    observeSitemap(l, [], later);
    expect(l.urls[job('/cerca-lavoro-ticino/a/')]).toBeUndefined();
  });
});

describe('planSubmissions', () => {
  const day0 = '2026-10-24';
  const seeded = () => {
    const l = createLedger(day0);
    observeSitemap(l, [
      { loc: job('/cerca-lavoro-zurigo/old-zh/'), lastmod: null },
      { loc: job('/en/find-jobs-ticino/old-ti-en/'), lastmod: null },
      { loc: job('/cerca-lavoro-ticino/old-ti/'), lastmod: null },
      { loc: job('/cerca-lavoro-berna/recent/'), lastmod: '2026-10-20' },
    ], day0);
    return l;
  };

  it('bootstrap backlog: newest lastmod first, then Ticino, then the Italian URL', () => {
    const plan = planSubmissions(seeded(), { today: day0, max: 10 });
    expect(plan.map((p) => p.url)).toEqual([
      job('/cerca-lavoro-berna/recent/'),
      job('/cerca-lavoro-ticino/old-ti/'),
      job('/en/find-jobs-ticino/old-ti-en/'),
      job('/cerca-lavoro-zurigo/old-zh/'),
    ]);
    expect(plan.every((p) => p.tier === 'backlog' && p.type === 'URL_UPDATED')).toBe(true);
    expect(backlogRank(job('/cerca-lavoro-ticino/x/'))).toBeLessThan(backlogRank(job('/cerca-lavoro-zurigo/x/')));
  });

  it('priority (no Jobs rich result) beats new, new beats delete, delete beats backlog', () => {
    const l = seeded();
    const day1 = '2026-10-25';
    observeSitemap(l, [
      { loc: job('/cerca-lavoro-zurigo/old-zh/'), lastmod: null },
      { loc: job('/en/find-jobs-ticino/old-ti-en/'), lastmod: null },
      { loc: job('/cerca-lavoro-berna/recent/'), lastmod: '2026-10-20' },
      { loc: job('/cerca-lavoro-vaud/brand-new/'), lastmod: '2026-10-25' },
    ], day1); // old-ti left the sitemaps
    const plan = planSubmissions(l, { today: day1, max: 10, priority: [job('/cerca-lavoro-zurigo/old-zh/'), job('/not/in/ledger/')] });
    expect(plan.slice(0, 3).map((p) => [p.tier, p.type, p.url])).toEqual([
      ['priority', 'URL_UPDATED', job('/cerca-lavoro-zurigo/old-zh/')],
      ['new', 'URL_UPDATED', job('/cerca-lavoro-vaud/brand-new/')],
      ['delete', 'URL_DELETED', job('/cerca-lavoro-ticino/old-ti/')],
    ]);
    // A priority URL that is not an active sitemap job is never sent.
    expect(plan.some((p) => p.url === job('/not/in/ledger/'))).toBe(false);
    // Each URL appears once.
    expect(new Set(plan.map((p) => p.url)).size).toBe(plan.length);
  });

  it('caps URL_DELETED at DELETE_SHARE of the run budget', () => {
    const l = createLedger(day0);
    const many = Array.from({ length: 40 }, (_, i) => ({ loc: job(`/cerca-lavoro-ticino/gone-${i}/`), lastmod: null }));
    observeSitemap(l, many, day0);
    observeSitemap(l, [], '2026-10-25');
    const plan = planSubmissions(l, { today: '2026-10-25', max: 20 });
    expect(plan.filter((p) => p.type === 'URL_DELETED')).toHaveLength(Math.floor(20 * DELETE_SHARE));
  });

  it('does not re-send what was sent, re-sends what the sitemap says changed', () => {
    const l = seeded();
    const sent = planSubmissions(l, { today: day0, max: 10 });
    for (const item of sent) recordOutcome(l, item, 'sent', day0);
    expect(spentOn(l, day0)).toBe(4);
    expect(planSubmissions(l, { today: day0, max: 10 })).toEqual([]);
    observeSitemap(l, [
      { loc: job('/cerca-lavoro-zurigo/old-zh/'), lastmod: null },
      { loc: job('/en/find-jobs-ticino/old-ti-en/'), lastmod: null },
      { loc: job('/cerca-lavoro-ticino/old-ti/'), lastmod: null },
      { loc: job('/cerca-lavoro-berna/recent/'), lastmod: '2026-10-26' },
    ], '2026-10-26');
    expect(planSubmissions(l, { today: '2026-10-26', max: 10 }).map((p) => [p.tier, p.url]))
      .toEqual([['updated', job('/cerca-lavoro-berna/recent/')]]);
  });

  it('a URL that failed the live JobPosting check waits before being retried', () => {
    const l = seeded();
    const [first] = planSubmissions(l, { today: day0, max: 1 });
    recordOutcome(l, first, 'not-job', day0);
    expect(planSubmissions(l, { today: '2026-10-26', max: 10 }).map((p) => p.url)).not.toContain(first.url);
    expect(planSubmissions(l, { today: '2026-11-01', max: 10 }).map((p) => p.url)).toContain(first.url);
  });

  it('keeps a URL retryable after a transient live-check failure', () => {
    const l = seeded();
    const [first] = planSubmissions(l, { today: day0, max: 1 });
    recordOutcome(l, first, 'transient', day0);
    expect(l.urls[first.url].n).toBeUndefined();
    expect(planSubmissions(l, { today: day0, max: 10 }).map((p) => p.url)).toContain(first.url);
  });

  it('returns nothing without budget', () => {
    expect(planSubmissions(seeded(), { today: day0, max: 0 })).toEqual([]);
  });
});

describe('judgeLive — never notify a non-job page, never delete a live one', () => {
  const jobHtml = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting"}</script>';
  it('URL_UPDATED only for 200 + JobPosting + indexable', () => {
    expect(judgeLive('URL_UPDATED', { status: 200, html: jobHtml })).toBe('ok');
    expect(judgeLive('URL_UPDATED', { status: 200, html: '<h1>Lavori OSS in Ticino</h1>' })).toBe('not-job');
    expect(judgeLive('URL_UPDATED', { status: 200, html: `<meta name="robots" content="noindex,follow">${jobHtml}` })).toBe('not-job');
    expect(judgeLive('URL_UPDATED', { status: 301 })).toBe('not-job');
  });
  it('URL_DELETED only for 404/410 or noindex', () => {
    expect(judgeLive('URL_DELETED', { status: 404 })).toBe('ok');
    expect(judgeLive('URL_DELETED', { status: 410 })).toBe('ok');
    expect(judgeLive('URL_DELETED', { status: 200, html: '<meta name="robots" content="noindex">' })).toBe('ok');
    expect(judgeLive('URL_DELETED', { status: 200, html: '<p>Annuncio scaduto</p>' })).toBe('still-live');
    expect(judgeLive('URL_DELETED', { status: 301 })).toBe('still-live');
  });
});

describe('submit-google-indexing-jobs CLI', () => {
  it('clamps --max to the daily job budget', () => {
    expect(parseArgs(['--max', '999']).max).toBe(DAILY_BUDGET);
    expect(parseArgs([]).max).toBe(15);
    expect(parseArgs(['--max', '130', '--priority-file', '/tmp/p.json', '--dry-run'])).toMatchObject({ max: 130, priorityFile: '/tmp/p.json', dryRun: true });
  });
});
