// @vitest-environment node
/**
 * Google Indexing API — the published dataset as a second source of job URLs.
 *
 * The job sitemaps only move with a full publish; from 2026-11-06 every
 * publish failed and the sitemaps stayed at 06-11 while the offer pages kept
 * going live through the section shards, so new offers were never notified.
 * These tests pin: how a dataset record becomes the same URL the build emits,
 * the merge with the sitemaps, the live check every dataset-only URL must
 * pass, the class precedence on mixed sources and the per-source report.
 */
import { describe, expect, it } from 'vitest';
import {
  DATASET_MIN_RECORDS,
  datasetJobEntries,
  jobDetailUrl,
  judgeDatasetLive,
  loadCantonResolvers,
  loadDatasetJobEntries,
  mergeJobSources,
} from '../scripts/lib/indexing-jobs-dataset.mjs';
import { jobSitemapLastmodDay as sharedLastmodDay } from '../scripts/lib/job-sitemap-lastmod.mjs';
import { jobSitemapLastmodDay as buildLastmodDay } from '../build-plugins/shared/jobSitemapLastmod';
import { buildCanonicalJobDetailPath } from '../build-plugins/shared/jobDetailPath';
import { ALL_CANTON_CODES, AGGREGATE_KEY } from '../build-plugins/shared/cantonSection';
import {
  NOT_JOB_RECHECK_DAYS,
  createLedger,
  daysBetween,
  observeSitemap,
  planSubmissions,
  recordOutcome,
} from '../scripts/lib/indexing-jobs-planner.mjs';
import { annotationText, cleanReportText, formatRunReport, selectLiveChecks } from '../scripts/submit-google-indexing-jobs.js';

const S = 'https://frontaliereticino.ch';
const job = (p: string) => `${S}${p}`;
const NOW = new Date();
const daysAgoIso = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const day = (n: number) => daysAgoIso(n).slice(0, 10);
const resolvers = loadCantonResolvers();

describe('dataset record → job-detail URL', () => {
  it('is the URL the build emits, for every canton and locale', () => {
    for (const canton of [...ALL_CANTON_CODES, AGGREGATE_KEY]) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(jobDetailUrl(resolvers, locale, canton, 'infermiere-x-1234')).toBe(
          `${S}${buildCanonicalJobDetailPath(locale, canton, 'infermiere-x-1234')}`,
        );
      }
    }
  });

  it('lastmod is the sitemap lastmod: one rule shared with the build', () => {
    const cases = [
      { postingDateSource: 'reported', datePosted: daysAgoIso(3), firstSeenAt: daysAgoIso(20) },
      { postingDateSource: 'reported', datePosted: daysAgoIso(30), firstSeenAt: daysAgoIso(9) },
      { postingDateSource: 'unknown', datePosted: daysAgoIso(1), firstSeenAt: daysAgoIso(9) },
      { postingDateSource: 'reported', datePosted: '2026-11-12T00:30:00+01:00' },
      { crawledAt: daysAgoIso(0) },
    ];
    for (const c of cases) expect(sharedLastmodDay(c)).toBe(buildLastmodDay(c));
  });

  it('derives one URL per locale from the slug map, with the posting day as lastmod', () => {
    const index = [{ id: 'a1', slug: 'it-slug-a1', canton: 'TI', location: 'Lugano', postingDateSource: 'reported', datePosted: daysAgoIso(0), firstSeenAt: daysAgoIso(0) }];
    const slugMap = [{ id: 'a1', slugByLocale: { it: 'it-slug-a1', en: 'en-slug-a1', de: 'de-slug-a1', fr: 'fr-slug-a1' } }];
    const entries = datasetJobEntries(index, slugMap, { resolvers, now: NOW });
    expect(entries.map((e) => e.loc)).toEqual([
      job('/cerca-lavoro-ticino/it-slug-a1/'),
      job('/en/find-jobs-ticino/en-slug-a1/'),
      job('/de/jobs-im-tessin/de-slug-a1/'),
      job('/fr/trouver-emploi-tessin/fr-slug-a1/'),
    ]);
    expect(entries.every((e) => e.lastmod === day(0) && e.id === 'a1')).toBe(true);
    // Without the slug map only the Italian URL can be derived.
    expect(datasetJobEntries(index, null, { resolvers, now: NOW }).map((e) => e.loc)).toEqual([job('/cerca-lavoro-ticino/it-slug-a1/')]);
  });
});

describe('mergeJobSources', () => {
  it('one entry per URL: the sitemap entry wins, with the later lastmod', () => {
    const sitemap = [
      { loc: job('/cerca-lavoro-ticino/both/'), lastmod: day(9) },
      { loc: job('/cerca-lavoro-ticino/sitemap-only/'), lastmod: day(9) },
    ];
    const dataset = [
      { loc: job('/cerca-lavoro-ticino/both/'), lastmod: day(2), id: 'b' },
      { loc: job('/cerca-lavoro-ticino/dataset-only/'), lastmod: day(0), id: 'd' },
    ];
    const m = mergeJobSources(sitemap, dataset);
    expect(m.entries).toEqual([
      { loc: job('/cerca-lavoro-ticino/both/'), lastmod: day(2) },
      { loc: job('/cerca-lavoro-ticino/sitemap-only/'), lastmod: day(9) },
      { loc: job('/cerca-lavoro-ticino/dataset-only/'), lastmod: day(0) },
    ]);
    expect([...m.datasetOnly]).toEqual([[job('/cerca-lavoro-ticino/dataset-only/'), 'd']]);
    expect(m.counts).toEqual({ sitemap: 2, dataset: 2, datasetOnly: 1, both: 1 });
  });

  it('counts every URL in both sources once, whatever the duplicates', () => {
    const loc = job('/cerca-lavoro-ticino/both/');
    const m = mergeJobSources([{ loc, lastmod: null }], [{ loc, lastmod: null, id: 'a' }, { loc, lastmod: null, id: 'a' }]);
    expect(m.counts.both).toBe(1);
  });

  it('an older dataset lastmod never moves a sitemap entry back', () => {
    const m = mergeJobSources([{ loc: job('/cerca-lavoro-ticino/x/'), lastmod: day(1) }], [{ loc: job('/cerca-lavoro-ticino/x/'), lastmod: day(5), id: 'x' }]);
    expect(m.entries[0].lastmod).toBe(day(1));
  });
});

describe('live check of a dataset-only URL', () => {
  const ld = (extra = '') => `<script type="application/ld+json">{"@type":"JobPosting","title":"T"${extra}}</script>`;
  const seed = (id: string) => `<script>window.__JOB_SEED__={"id":"${id}","slug":"s"};</script>`;
  const page = (body: string, robots = 'index, follow') => `<html><head><meta name=robots content="${robots}">${body}</head></html>`;
  const future = new Date(NOW.getTime() + 30 * 86_400_000).toISOString();

  it('sends only the ACTIVE detail page of the same job', () => {
    expect(judgeDatasetLive({ status: 200, html: page(ld(`,"validThrough":"${future}"`) + seed('j1')) }, { id: 'j1', now: NOW })).toBe('ok');
  });

  it('not published yet (404/410) is parked, not penalised as not-job', () => {
    expect(judgeDatasetLive({ status: 404, html: '' }, { id: 'j1' })).toBe('not-live');
    expect(judgeDatasetLive({ status: 410, html: '' }, { id: 'j1' })).toBe('not-live');
  });

  it('noindex, no JobPosting, a redirect or an edge error are never sent', () => {
    expect(judgeDatasetLive({ status: 200, html: page(ld() + seed('j1'), 'noindex, follow') }, { id: 'j1' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 200, html: page(seed('j1')) }, { id: 'j1' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 301, html: '' }, { id: 'j1' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 503, html: '' }, { id: 'j1' })).toBe('transient');
  });

  it('the «Offerta non verificata» stub and the expired soft-landing are never sent, even with an archived JobPosting', () => {
    // Both carry __EXPIRED_JOB_DATA__ and never the active-page seed.
    const stub = page(`<title>Offerta non verificata</title>${ld(`,"validThrough":"${daysAgoIso(3)}"`)}<script>window.__EXPIRED_JOB_DATA__={"slug":"s"};</script>`);
    expect(judgeDatasetLive({ status: 200, html: stub }, { id: 'j1', now: NOW })).toBe('not-job');
    // A seeded page whose JobPosting already expired is not active either.
    expect(judgeDatasetLive({ status: 200, html: page(ld(`,"validThrough":"${daysAgoIso(1)}"`) + seed('j1')) }, { id: 'j1', now: NOW })).toBe('not-job');
  });

  it('a page seeded with another job is not this job', () => {
    expect(judgeDatasetLive({ status: 200, html: page(ld() + seed('other')) }, { id: 'j1' })).toBe('not-job');
  });

  it('the seed id must match exactly, at the top level of the seed', () => {
    // Reviewer acceptance (PR 18373): a longer id sharing the prefix is another job.
    expect(judgeDatasetLive({ status: 200, html: page(ld() + '<script>window.__JOB_SEED__={"id":"job-1234"}</script>') }, { id: 'job-123' })).toBe('not-job');
    // An "id" nested in another field does not name the job of the page.
    expect(judgeDatasetLive({ status: 200, html: page(ld() + '<script>window.__JOB_SEED__={"id":"other","company":{"id":"job-123"}};</script>') }, { id: 'job-123' })).toBe('not-job');
    // A seed that is not a JSON object cannot be attributed to any job.
    expect(judgeDatasetLive({ status: 200, html: page(ld() + '<script>window.__JOB_SEED__={"id":"job-123",</script>') }, { id: 'job-123' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 200, html: page(ld() + '<script>window.__JOB_SEED__={"id":"job-123"};</script>') }, { id: 'job-123' })).toBe('ok');
  });

  it('without a job id the page cannot be attributed: never sent', () => {
    // Reviewer acceptance (PR 18373, review 5883241033).
    const other = page(ld() + '<script>window.__JOB_SEED__={"id":"other-job"}</script>');
    expect(judgeDatasetLive({ status: 200, html: other }, { id: null })).toBe('not-job');
    expect(judgeDatasetLive({ status: 200, html: other }, { id: '' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 200, html: other }, { id: '   ' })).toBe('not-job');
    expect(judgeDatasetLive({ status: 200, html: other })).toBe('not-job');
  });

  it('a dataset record without a string id yields no URL at all', () => {
    const index = [
      { id: null, slug: 'no-id', canton: 'TI' },
      { id: '', slug: 'empty-id', canton: 'TI' },
      { slug: 'missing-id', canton: 'TI' },
      { id: 'ok-1', slug: 'with-id', canton: 'TI' },
    ];
    expect(datasetJobEntries(index, null, { resolvers, now: NOW }).map((e) => [e.loc, e.id])).toEqual([
      [job('/cerca-lavoro-ticino/with-id/'), 'ok-1'],
    ]);
  });
});

describe('planner on mixed sources', () => {
  const created = day(30);
  const today = day(0);

  const ledgerWith = (sitemap: Array<{ loc: string; lastmod: string | null }>, dataset: Array<{ loc: string; lastmod: string | null; id: string }>) => {
    const l = createLedger(created);
    const m = mergeJobSources(sitemap, dataset);
    observeSitemap(l, m.entries, today, { datasetOnly: m.datasetOnly });
    return { l, m };
  };

  it('a dataset-only entry is "new" by its posting day, never by the day the source was switched on', () => {
    const { l } = ledgerWith([], [
      { loc: job('/cerca-lavoro-ticino/posted-today/'), lastmod: today, id: 'a' },
      { loc: job('/cerca-lavoro-ticino/posted-last-week/'), lastmod: day(6), id: 'b' },
    ]);
    expect(l.urls[job('/cerca-lavoro-ticino/posted-today/')].o).toBe(1);
    const plan = planSubmissions(l, { today, max: 10 });
    expect(plan.map((p) => [p.tier, p.url])).toEqual([
      ['new', job('/cerca-lavoro-ticino/posted-today/')],
      ['backlog', job('/cerca-lavoro-ticino/posted-last-week/')],
    ]);
  });

  it('class precedence is unchanged across sources: priority, new, delete, updated, backlog', () => {
    const l = createLedger(created);
    const earlier = day(5);
    const sm0 = [
      { loc: job('/cerca-lavoro-ticino/priority/'), lastmod: day(20) },
      { loc: job('/cerca-lavoro-ticino/will-expire/'), lastmod: day(20) },
      { loc: job('/cerca-lavoro-ticino/updated/'), lastmod: day(20) },
      { loc: job('/cerca-lavoro-ticino/backlog/'), lastmod: day(20) },
    ];
    observeSitemap(l, sm0, earlier);
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/updated/'), type: 'URL_UPDATED' }, 'sent', day(10));
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/will-expire/'), type: 'URL_UPDATED' }, 'sent', day(10));
    const m = mergeJobSources(
      sm0.filter((e) => !e.loc.includes('will-expire')),
      [
        { loc: job('/cerca-lavoro-ticino/updated/'), lastmod: day(2), id: 'u' },
        { loc: job('/cerca-lavoro-zurigo/dataset-new/'), lastmod: today, id: 'n' },
        { loc: job('/cerca-lavoro-zurigo/dataset-backlog/'), lastmod: day(4), id: 'k' },
      ],
    );
    observeSitemap(l, m.entries, today, { datasetOnly: m.datasetOnly });
    const plan = planSubmissions(l, { today, max: 20, priority: [job('/cerca-lavoro-ticino/priority/')] });
    expect(plan.map((p) => [p.tier, p.url])).toEqual([
      ['priority', job('/cerca-lavoro-ticino/priority/')],
      ['new', job('/cerca-lavoro-zurigo/dataset-new/')],
      ['delete', job('/cerca-lavoro-ticino/will-expire/')],
      ['updated', job('/cerca-lavoro-ticino/updated/')],
      ['backlog', job('/cerca-lavoro-zurigo/dataset-backlog/')],
      ['backlog', job('/cerca-lavoro-ticino/backlog/')],
    ]);
  });

  it('a not-yet-published URL is re-checked the next quota day, a not-job page after the usual penalty', () => {
    const { l } = ledgerWith([], [
      { loc: job('/cerca-lavoro-ticino/pending/'), lastmod: today, id: 'p' },
      { loc: job('/cerca-lavoro-ticino/noindex/'), lastmod: today, id: 'q' },
    ]);
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/pending/'), type: 'URL_UPDATED' }, 'not-live', today);
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/noindex/'), type: 'URL_UPDATED' }, 'not-job', today);
    expect(planSubmissions(l, { today, max: 10 })).toEqual([]);
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(planSubmissions(l, { today: tomorrow, max: 10 }).map((p) => p.url)).toEqual([job('/cerca-lavoro-ticino/pending/')]);
    const afterPenalty = new Date(Date.parse(`${today}T12:00:00Z`) + NOT_JOB_RECHECK_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(daysBetween(today, afterPenalty)).toBe(NOT_JOB_RECHECK_DAYS);
    expect(planSubmissions(l, { today: afterPenalty, max: 10 }).map((p) => p.url)).toContain(job('/cerca-lavoro-ticino/noindex/'));
    // Sending clears the parking marker.
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/pending/'), type: 'URL_UPDATED' }, 'sent', tomorrow);
    expect(l.urls[job('/cerca-lavoro-ticino/pending/')].u).toBeUndefined();
  });

  it('a dataset-only URL Google never heard of is forgotten when it leaves, never URL_DELETED', () => {
    const { l } = ledgerWith([], [
      { loc: job('/cerca-lavoro-ticino/never-sent/'), lastmod: day(3), id: 'a' },
      { loc: job('/cerca-lavoro-ticino/was-sent/'), lastmod: day(3), id: 'b' },
    ]);
    recordOutcome(l, { url: job('/cerca-lavoro-ticino/was-sent/'), type: 'URL_UPDATED' }, 'sent', today);
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    observeSitemap(l, [], tomorrow, { datasetOnly: new Map() });
    expect(l.urls[job('/cerca-lavoro-ticino/never-sent/')]).toBeUndefined();
    expect(planSubmissions(l, { today: tomorrow, max: 10 }).map((p) => [p.tier, p.type, p.url])).toEqual([
      ['delete', 'URL_DELETED', job('/cerca-lavoro-ticino/was-sent/')],
    ]);
  });

  it('a URL seen in a sitemap is no longer dataset-only', () => {
    const { l } = ledgerWith([], [{ loc: job('/cerca-lavoro-ticino/x/'), lastmod: today, id: 'x' }]);
    expect(l.urls[job('/cerca-lavoro-ticino/x/')].o).toBe(1);
    observeSitemap(l, [{ loc: job('/cerca-lavoro-ticino/x/'), lastmod: today }], today, { datasetOnly: new Map() });
    expect(l.urls[job('/cerca-lavoro-ticino/x/')].o).toBeUndefined();
  });
});

describe('selectLiveChecks', () => {
  it('tags the source and caps the dataset-only checks so the sitemap URLs are never starved', () => {
    const plan = [
      ...Array.from({ length: 5 }, (_, i) => ({ url: job(`/cerca-lavoro-ticino/d${i}/`), type: 'URL_UPDATED', tier: 'new' })),
      ...Array.from({ length: 5 }, (_, i) => ({ url: job(`/cerca-lavoro-ticino/s${i}/`), type: 'URL_UPDATED', tier: 'backlog' })),
    ];
    const datasetOnly = new Map(plan.slice(0, 5).map((p, i) => [p.url, `id${i}`]));
    const picked = selectLiveChecks(plan, datasetOnly, { maxChecks: 6, maxDatasetChecks: 2 });
    expect(picked.map((p) => [p.source, p.id])).toEqual([
      ['dataset', 'id0'], ['dataset', 'id1'],
      ['sitemap', null], ['sitemap', null], ['sitemap', null], ['sitemap', null],
    ]);
  });
});

describe('run report', () => {
  it('splits every class between sitemap and dataset URLs and states the input of each source', () => {
    const r = formatRunReport({
      outcome: 'Done',
      byTier: { new: 7, backlog: 3 },
      bySource: { sitemap: { new: 1, backlog: 3 }, dataset: { new: 6 } },
      sources: { sitemap: 94742, dataset: 134498, datasetOnly: 57415, both: 77083, datasetError: null },
      liveSkipped: 4, notLive: 3, spent: 10, today: '2026-11-12',
    });
    expect(r.line).toContain('sent 10 (new=7 delete=0 priority=0 updated=0 backlog=3)');
    expect(r.line).toContain('[sitemap: new=1 delete=0 priority=0 updated=0 backlog=3; dataset: new=6 delete=0 priority=0 updated=0 backlog=0]');
    expect(r.line).toContain('4 by live check (3 dataset-only not published yet)');
    expect(r.line).toContain('input: 94742 sitemap URLs + 57415 dataset-only of 134498 dataset URLs');
    const table = r.table.join('\n');
    expect(table).toContain('| sitemap | 1 | 0 | 0 | 0 | 3 |');
    expect(table).toContain('| dataset | 6 | 0 | 0 | 0 | 0 |');
  });

  it('says when the dataset was skipped, on one line and without breaking the table', () => {
    const r = formatRunReport({ outcome: 'Done', sources: { sitemap: 10, dataset: 0, datasetOnly: 0, both: 0, datasetError: 'HTTP 503' }, today: '2026-11-12' });
    expect(r.line).toContain('dataset unavailable (HTTP 503)');
    const nasty = formatRunReport({ outcome: 'Nothing to notify', sources: { sitemap: 10, dataset: 0, datasetOnly: 0, both: 0, datasetError: 'bad | gateway\nline two' }, today: '2026-11-12' });
    expect(nasty.line).toContain('dataset unavailable (bad \\| gateway line two)');
    expect(nasty.table.every((row) => !row.includes('\n'))).toBe(true);
  });

  it('tolerates legacy callers without bySource or sources', () => {
    const r = formatRunReport({ outcome: 'Done', byTier: { backlog: 2 }, today: '2026-11-12' });
    expect(r.line).toContain('sent 2 (new=0 delete=0 priority=0 updated=0 backlog=2)');
    expect(r.line).toContain('[sitemap: new=0 delete=0 priority=0 updated=0 backlog=0; dataset: new=0 delete=0 priority=0 updated=0 backlog=0]');
    expect(r.line).not.toContain('input:');
    expect(r.table.join('\n')).toContain('| sitemap | 0 | 0 | 0 | 0 | 0 |');
  });

  it('annotation text is one line with workflow-command data escaping', () => {
    expect(annotationText('HTTP 503 | 100%\r\nnext::error::x')).toBe('HTTP 503 \\| 100%25 next::error::x');
    expect(annotationText('a\nb')).not.toMatch(/[\r\n]/);
    expect(cleanReportText('a | b\nc')).toBe('a \\| b c');
  });

  it('repeats the slug-map fallback warning in every report, early returns included', () => {
    const r = formatRunReport({
      outcome: 'Daily quota already spent — nothing sent',
      sources: { sitemap: 10, dataset: 4, datasetOnly: 4, both: 0, datasetError: null, datasetWarning: 'jobs-slug-map.json: HTTP 404 — Italian URLs only' },
      today: '2026-11-12',
    });
    expect(r.line).toContain('(jobs-slug-map.json: HTTP 404 — Italian URLs only)');
    expect(r.table.join('\n')).toContain('Italian URLs only');
  });
});

describe('loadDatasetJobEntries never fails the run', () => {
  const okJson = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
  const index = Array.from({ length: DATASET_MIN_RECORDS }, (_, i) => ({ id: `j${i}`, slug: `slug-${i}`, canton: 'TI', firstSeenAt: daysAgoIso(1) }));

  it('network or HTTP error → no entries, an error to warn about', async () => {
    const down = await loadDatasetJobEntries({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, resolvers });
    expect(down.entries).toEqual([]);
    expect(down.error).toContain('ECONNRESET');
    const http = await loadDatasetJobEntries({ fetchImpl: async () => ({ ok: false, status: 503 }) as Response, resolvers });
    expect(http.error).toContain('HTTP 503');
  });

  it('a truncated file is ignored', async () => {
    const r = await loadDatasetJobEntries({ fetchImpl: okJson(index.slice(0, 10)) as unknown as typeof fetch, resolvers });
    expect(r.entries).toEqual([]);
    expect(r.error).toContain('below');
  });

  it('without the slug map the Italian URLs still flow, with a warning', async () => {
    let call = 0;
    const fetchImpl = (async () => (call++ === 0 ? { ok: true, status: 200, json: async () => index } : { ok: false, status: 404 })) as unknown as typeof fetch;
    const r = await loadDatasetJobEntries({ fetchImpl, resolvers, now: NOW });
    expect(r.error).toBeNull();
    expect(r.warning).toContain('Italian URLs only');
    expect(r.entries).toHaveLength(DATASET_MIN_RECORDS);
    expect(r.entries[0].loc).toBe(job('/cerca-lavoro-ticino/slug-0/'));
  });
});
