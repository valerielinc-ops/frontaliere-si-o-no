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
  recordNotification,
  reserveQuota,
  judgeLive,
  spentOn,
  backlogRank,
  newRank,
  countDedupSkipped,
  GONE_FORGET_DAYS,
  PRIORITY_RESUBMIT_DAYS,
} from '../scripts/lib/indexing-jobs-planner.mjs';
import {
  parseArgs,
  runBudgetFor,
  runLiveChecks,
  formatRunReport,
  LIVE_CHECK_CONCURRENCY,
  DAILY_BUDGET,
} from '../scripts/submit-google-indexing-jobs.js';
import { DEFAULT_DAILY_QUOTA } from '../scripts/lib/indexing-api-quota.mjs';

const S = 'https://frontaliereticino.ch';
const testDay = '2026-10-24';
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
  it('starts from zero only when no ledger exists', () => {
    expect(loadLedger(null, '2026-10-24')).toEqual(createLedger('2026-10-24'));
  });

  it('rejects anything that would forget the spent quota', () => {
    const valid = createLedger('2026-10-24');
    expect(loadLedger('not json', '2026-10-24')).toBeNull();
    expect(loadLedger('', '2026-10-24')).toBeNull();
    expect(loadLedger(JSON.stringify({ ...valid, version: 999 }), '2026-10-24')).toBeNull();
    expect(loadLedger(JSON.stringify({ ...valid, days: undefined }), '2026-10-24')).toBeNull();
    expect(loadLedger(JSON.stringify({ ...valid, days: ['1999'] }), '2026-10-24')).toBeNull();
    expect(loadLedger(JSON.stringify({ ...valid, days: { '2026-10-24': 'many' } }), '2026-10-24')).toBeNull();
    expect(loadLedger(JSON.stringify({ ...valid, days: { '2026-10-24': -1 } }), '2026-10-24')).toBeNull();
  });

  it('accepts ledgers written before notifications existed', () => {
    const { notifications: _omitted, ...legacy } = createLedger('2026-10-24');
    expect(loadLedger(JSON.stringify(legacy), '2026-10-24')?.notifications).toEqual({});
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

  it('the daily quota is the one Google grants (200), not the 2,000 once requested', () => {
    // 2026-11-03 → 2026-11-09: every run stopped on 429 after ~200 publishes.
    expect(DEFAULT_DAILY_QUOTA).toBe(200);
    expect(DAILY_BUDGET).toBe(200);
  });

  it('shares the daily quota between job and article callers', () => {
    const l = createLedger(testDay);
    l.days[testDay] = DAILY_BUDGET - 40; // job publishes already accounted for.
    const articleUrls = Array.from({ length: 40 }, (_, i) => `${S}/articoli-frontaliere/article-${i}/`);

    for (const url of articleUrls) {
      expect(reserveQuota(l, testDay)).toBe(true);
      recordNotification(l, { url, source: 'article' }, { ok: true, status: 200 }, testDay);
    }

    expect(spentOn(l, testDay)).toBe(DAILY_BUDGET);
    expect(reserveQuota(l, testDay)).toBe(false);
    expect(Object.keys(l.notifications)).toHaveLength(40);
    expect(l.notifications[articleUrls[0]]).toMatchObject({ source: 'article', sent: testDay });
  });
});

describe('bounded live-check queue', () => {
  it('handles 2,000 timeout-equivalent checks without serial execution', async () => {
    let active = 0;
    let peak = 0;
    const plan = Array.from({ length: 2_000 }, (_, i) => ({
      url: `${S}/cerca-lavoro-ticino/job-${i}/`,
      type: 'URL_UPDATED' as const,
    }));
    const started = Date.now();
    const results = await runLiveChecks(plan, {
      concurrency: LIVE_CHECK_CONCURRENCY,
      check: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return 'transient' as const;
      },
    });

    expect(results).toHaveLength(2_000);
    expect(results.every(({ verdict }) => verdict === 'transient')).toBe(true);
    expect(peak).toBeLessThanOrEqual(LIVE_CHECK_CONCURRENCY);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
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

  it('priority beats new and delete, then the remaining tiers keep their order', () => {
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

  it('every expired job is planned as URL_DELETED before any update, once', () => {
    const l = createLedger(day0);
    const many = Array.from({ length: 40 }, (_, i) => ({ loc: job(`/cerca-lavoro-ticino/gone-${i}/`), lastmod: null }));
    observeSitemap(l, [...many, { loc: job('/cerca-lavoro-ticino/still-here/'), lastmod: '2026-10-01' }], day0);
    observeSitemap(l, [{ loc: job('/cerca-lavoro-ticino/still-here/'), lastmod: '2026-10-01' }], '2026-10-25');
    const plan = planSubmissions(l, { today: '2026-10-25', max: 20 });
    expect(plan.slice(0, 40).every((p) => p.type === 'URL_DELETED')).toBe(true);
    expect(plan[40]).toMatchObject({ tier: 'backlog', url: job('/cerca-lavoro-ticino/still-here/') });
    for (const item of plan.slice(0, 40)) recordOutcome(l, item, 'sent', '2026-10-25');
    expect(planSubmissions(l, { today: '2026-10-26', max: 20 }).some((p) => p.type === 'URL_DELETED')).toBe(false);
  });

  it('new = never notified and posted in the last 24h; the Italian URL of every new job goes first', () => {
    const l = createLedger(day0);
    observeSitemap(l, [
      { loc: job('/cerca-lavoro-ticino/old/'), lastmod: '2026-10-20' },
    ], day0);
    const day1 = '2026-10-25';
    observeSitemap(l, [
      { loc: job('/cerca-lavoro-ticino/old/'), lastmod: '2026-10-20' },
      { loc: job('/en/find-jobs-ticino/fresh-ti/'), lastmod: '2026-10-25' },
      { loc: job('/cerca-lavoro-zurigo/fresh-zh/'), lastmod: '2026-10-24' },
      { loc: job('/cerca-lavoro-ticino/fresh-ti/'), lastmod: '2026-10-25' },
      // Posted 4 days ago, published late: still never seen by Google → new.
      { loc: job('/cerca-lavoro-berna/late/'), lastmod: '2026-10-21' },
    ], day1);
    const plan = planSubmissions(l, { today: day1, max: 10 });
    expect(plan.filter((p) => p.tier === 'new').map((p) => p.url)).toEqual([
      job('/cerca-lavoro-ticino/fresh-ti/'),
      job('/cerca-lavoro-zurigo/fresh-zh/'),
      job('/cerca-lavoro-berna/late/'),
      job('/en/find-jobs-ticino/fresh-ti/'),
    ]);
    expect(plan.find((p) => p.url === job('/cerca-lavoro-ticino/old/'))?.tier).toBe('backlog');
    expect(newRank(job('/cerca-lavoro-zurigo/x/'))).toBeLessThan(newRank(job('/en/find-jobs-ticino/x/')));
  });

  it('re-notifies a monitored URL after the priority cooldown, but not before', () => {
    const l = seeded();
    for (const item of planSubmissions(l, { today: day0, max: 10 })) recordOutcome(l, item, 'sent', day0);
    expect(countDedupSkipped(l)).toBe(4);
    const beforeCooldown = '2026-10-26';
    expect(planSubmissions(l, {
      today: beforeCooldown,
      max: 10,
      priority: [job('/cerca-lavoro-zurigo/old-zh/')],
    })).toEqual([]);
    const due = '2026-10-27';
    expect(planSubmissions(l, {
      today: due,
      max: 10,
      priority: [job('/cerca-lavoro-zurigo/old-zh/')],
    })).toEqual([{
      url: job('/cerca-lavoro-zurigo/old-zh/'),
      type: 'URL_UPDATED',
      tier: 'priority',
    }]);
    expect(PRIORITY_RESUBMIT_DAYS).toBe(3);
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

  it('a transient live-check failure leaves the URL plannable on the next run', () => {
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
  it('429/5xx at the edge is transient, not a verdict on the page', () => {
    expect(judgeLive('URL_UPDATED', { status: 503 })).toBe('transient');
    expect(judgeLive('URL_UPDATED', { status: 429 })).toBe('transient');
    expect(judgeLive('URL_DELETED', { status: 502 })).toBe('transient');
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
    expect(parseArgs(['--max', '9999']).max).toBe(DAILY_BUDGET);
    expect(parseArgs([]).max).toBe(15);
    expect(parseArgs(['--max', '130', '--priority-file', '/tmp/p.json', '--dry-run'])).toMatchObject({ max: 130, priorityFile: '/tmp/p.json', dryRun: true });
  });

  it('the first run of the quota day takes the large share, later runs the small one, never past the budget', () => {
    // monitor-gsc-seo.yml: 200 quota - 60 reserved for post-publish top-ups.
    const args = parseArgs(['--max', '15', '--max-first-run', '140']);
    expect(runBudgetFor(args, 0)).toBe(140);
    expect(runBudgetFor(args, 140)).toBe(15);
    expect(runBudgetFor(args, DAILY_BUDGET - 1)).toBe(1);
    expect(runBudgetFor(args, DAILY_BUDGET)).toBe(0);
    expect(parseArgs(['--max-first-run', '2000']).maxFirstRun).toBe(DAILY_BUDGET);
  });

  it('an explicit --max 0 is a hard cap, even on the first run of the quota day', () => {
    expect(runBudgetFor({ max: 0, maxFirstRun: 140 }, 0)).toBe(0);
    expect(runBudgetFor(parseArgs(['--max', '0', '--max-first-run', '140']), 0)).toBe(0);
  });

  it('every run reports sent per class, skipped for dedup and quota left', () => {
    const r = formatRunReport({
      outcome: 'Done', byTier: { new: 12, delete: 3 }, dedupSkipped: 143, liveSkipped: 2, failed: 1, spent: 70, today: '2026-11-10',
    });
    expect(r.line).toContain('sent 15 (new=12 delete=3 priority=0 updated=0 backlog=0)');
    expect(r.line).toContain('skipped 143 for dedup');
    expect(r.line).toContain(`quota 70/${DAILY_BUDGET} used, ${DAILY_BUDGET - 70} left`);
    expect(r.table.join('\n')).toContain(`| 12 | 3 | 0 | 0 | 0 | 143 | 2 | 1 | 70/${DAILY_BUDGET} | ${DAILY_BUDGET - 70} |`);
  });
});
