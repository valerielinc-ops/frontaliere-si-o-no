/**
 * The ghost gate must not lose routes.
 *
 * It used to delete the whole archive record after copying only its current and
 * flat slugs to the active job, so per-locale `previousSlugsByLocale` routes
 * left both datasets. A record may now leave only when the matched active job
 * holds every route it served. Per-locale history moves only when both records
 * name the same posting with their own URL or source identity.
 *
 * All fixtures are invented.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileGhostExpired } from '../scripts/assemble-jobs-dataset.mjs';
import { reconcileExpiredSlugs } from '../scripts/reconcile-job-slugs.mjs';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';
import { hasSinglePostingToken } from '../scripts/lib/ghost-route-transfer.mjs';

const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-keep-slices-'));
afterAll(() => fs.rmSync(sliceDir, { recursive: true, force: true }));

const POSTING = 'https://careers.example-garden.test/jobs/greenhouse-keeper/7f3c9a2e-5b41-4d8e-9c02-6a1b2c3d4e5f';
const OTHER = 'https://careers.example-garden.test/jobs/greenhouse-keeper/0b9d8c7a-1e2f-4a3b-8c9d-0e1f2a3b4c5d';
const LISTING = 'https://careers.example-garden.test/it/jobs';
const META = { title: 'Greenhouse Keeper', company: 'Example Garden', location: 'Exampletown' };
const SHARED_IT = 'serrista-example-garden-exampletown';

type Job = Record<string, any>;

function activeJob(overrides: Job = {}): Job {
  return {
    ...META,
    url: POSTING,
    slug: SHARED_IT,
    slugByLocale: { it: SHARED_IT, en: 'greenhouse-keeper-example-garden-exampletown' },
    ...overrides,
  };
}

function ghost(overrides: Job = {}): Job {
  return {
    ...META,
    slug: SHARED_IT,
    slugByLocale: { it: SHARED_IT, de: 'gewaechshausgaertner-example-garden' },
    previousSlugsByLocale: {
      de: ['alter-gaertner-example-garden'],
      fr: ['ancien-serriste-example-garden'],
    },
    previousSlugs: ['alter-gaertner-example-garden', 'ancien-serriste-example-garden', 'legacy-only-example-garden'],
    sourceIdentity: `url:${POSTING}`,
    expiredAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  };
}

const routesOf = (...groups: Job[][]) => new Set(groups.flat().flatMap((job) => [...localeRouteKeys(job)]));

function run(active: Job[], expired: Job[], dir = sliceDir) {
  const before = routesOf(active, expired);
  const result = reconcileGhostExpired(active, expired, { sliceDir: dir });
  const after = routesOf(active, result.cleanedExpired);
  // The invariant: no route served by the input leaves both datasets.
  expect([...before].filter((route) => !after.has(route))).toEqual([]);
  return result;
}

const holds = (job: Job, slug: string) => [...localeRouteKeys(job)].some((route) => route.endsWith(`:${slug}`));

describe('reconcileGhostExpired — routes survive the ghost gate', () => {
  it('moves each locale history to the same posting and then drops the record', () => {
    const active = activeJob();
    const result = run([active], [ghost()]);

    expect(result.cleanedExpired).toEqual([]);
    expect(active.previousSlugsByLocale.de).toContain('alter-gaertner-example-garden');
    expect(active.previousSlugsByLocale.fr).toEqual(['ancien-serriste-example-garden']);
    expect(active.previousSlugsByLocale.it ?? []).not.toContain('alter-gaertner-example-garden');
    // A slug with unknown locale stays served under all four.
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(localeRouteKeys(active).has(`${locale}:legacy-only-example-garden`)).toBe(true);
    }
  });

  it('does not assign locale history proven only by the merge history, and keeps the record', () => {
    const active = activeJob();
    const record = ghost({
      sourceIdentity: `url:${OTHER}`,
      sourceIdentityHistory: [{ sourceIdentity: `url:${POSTING}` }],
    });
    const result = run([active], [record]);

    expect(result.cleanedExpired).toEqual([record]);
    expect(result.retainedGhostCount).toBe(1);
    expect(result.ghostCount).toBe(0);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
    expect(holds(active, 'alter-gaertner-example-garden')).toBe(false);
  });

  it('does not treat a listing-page URL as the identity of one posting', () => {
    const active = activeJob({ url: LISTING });
    const record = ghost({ sourceIdentity: `url:${LISTING}` });
    const result = run([active], [record]);

    expect(result.cleanedExpired).toEqual([record]);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
  });

  it('does not assign history when a third record names the same URL for another job', () => {
    const active = activeJob();
    const record = ghost();
    const third = {
      ...META, title: 'Orchard Foreman', slug: 'capo-frutteto-example-garden',
      slugByLocale: { it: 'capo-frutteto-example-garden' }, sourceIdentity: `url:${POSTING}`,
    };
    const result = run([active], [record, third]);

    expect(result.cleanedExpired).toContain(record);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
  });

  it('never evicts a route when a bucket is full: the record keeps what does not fit', () => {
    const full = Array.from({ length: 20 }, (_, index) => `old-french-${index}-example-garden`);
    const active = activeJob({ previousSlugsByLocale: { fr: [...full] }, previousSlugs: [...full] });
    const record = ghost();
    const result = run([active], [record]);

    expect(active.previousSlugsByLocale.fr).toEqual(full);
    expect(result.cleanedExpired).toEqual([record]);
  });

  it('keeps every record sharing a ghost identity while one of them holds an uncovered route', () => {
    const dir = fs.mkdtempSync(path.join(sliceDir, 'shared-'));
    const covered = ghost({
      id: 'shared-id', sourceIdentity: undefined, url: POSTING,
      slugByLocale: { it: SHARED_IT }, previousSlugs: [], previousSlugsByLocale: {},
    });
    const uncovered = {
      ...META, title: 'Orchard Foreman', url: POSTING, slug: 'capo-frutteto-example-garden',
      slugByLocale: { it: 'capo-frutteto-example-garden' }, expiredAt: '2026-01-09T00:00:00.000Z',
    };
    const file = path.join(dir, 'example-garden.json');
    fs.writeFileSync(file, JSON.stringify([covered, uncovered]));
    const result = run([activeJob()], [covered, uncovered], dir);

    expect(result.cleanedExpired).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(2);
  });
});

describe('hasSinglePostingToken — the token must sit where a posting is named', () => {
  const UUID = '7f3c9a2e-5b41-4d8e-9c02-6a1b2c3d4e5f';
  const HASH = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const base = 'https://careers.example-garden.test';

  it.each([
    // The review's example, then the same class for each token shape.
    `url:${base}/it/jobs?postalCode=12345`,
    `url:${base}/it/jobs?sid=${HASH}`,
    `url:${base}/it/jobs?utm_id=${UUID}`,
    `url:${base}/it/jobs?companyId=123456`,
    `url:${base}/it/jobs?tenant=${UUID}`,
    `url:${base}/jobs/search?team=231361275`,
    'url:https://recruiting-123456.example-garden.test/it/jobs',
    `url:https://${HASH}.example-garden.test/it/jobs`,
    // Ancestor segments name a board, a tenant, a session or a folder.
    `url:${base}/${UUID}/jobs`,
    `url:${base}/878019/0445/pub/3/index.html`,
    `url:${base}/uploads/1/4/146598773/greenhouse_keeper.pdf`,
    `url:${base}/s/${HASH}/it/jobs`,
    `url:${base}/it/jobs;jsessionid=${HASH}`,
    // The segment before the token says what it names.
    `url:${base}/jobs/company/123456`,
    `url:${base}/jobs/plz/12345`,
    `url:${base}/job/greenhouse-keeper/widgetid/${UUID}`,
    `url:${base}/jobs/123456/search`,
    // A path token counts only under an explicit posting segment: slug+id and
    // UUID leaves follow the same rule as bare numbers.
    `url:${base}/it/search/12345`,
    `url:${base}/it/12345`,
    `url:${base}/greenhouse-keeper-j123456.html?sid=${HASH}`,
    `url:${base}/careers/greenhouse-keeper-123456`,
    `url:${base}/careers/${UUID}`,
    // Never under a search, list or filter segment.
    `url:${base}/jobs/search/12345`,
    `url:${base}/job-search/12345`,
    `url:${base}/job-search/${UUID}`,
    `url:${base}/jobs/page/12345`,
    `url:${base}/jobs/category/12345`,
    `url:${base}/jobs/results/greenhouse-keeper-123456`,
    `url:${base}/search/jobs/12345`,
    // A bare number needs a posting segment or a title right before it.
    `url:${base}/jobs/region/12345`,
    // One normalisation before any classification; doubt is not proof.
    `url:${base}/it/jobs/%73earch/foo-12345`,
    `url:${base}/it/jobs/%2573earch/foo-12345`,
    `url:${base}/it/jobs/%E0%A4%A/foo-12345`,
    `url:${base}/it/jobs/a%2Fsearch/foo-12345`,
    `url:${base}/it/jobs/a%5Csearch/foo-12345`,
    `url:${base}/it/jobs/search%3Fq/foo-12345`,
    `url:${base}/it/jobs/search%23x/foo-12345`,
    `url:${base}/it/jobs/a%00b/foo-12345`,
    `url:${base}/%6Aobs/foo-12345`,
    `url:${base}/%20jobs/foo-12345`,
    `url:${base}/jobs/%32%33%34%35%36`,
    `url:${base}/jobs//12345`,
    `url:${base}/job//greenhouse-keeper-123456`,
    `url:${base}/jobs/..;a/foo-12345`,
    `url:${base}/jobs/search/./foo-12345`,
    `url:${base}/jobs/12345/../search/foo-12345`,
    `url:${base}/jobs/Search/foo-12345`,
    `url:${base}/jobs/search.html/foo-12345`,
    `url:${base}/jobs/results.aspx/foo-12345`,
    `url:${base}/jobs/job_search/foo-12345`,
    `url:${base}/jobs/search-results/foo-12345`,
    `url:${base}/jobs/Search_Results.php/foo-12345`,
    `url:${base}/jobs/suche/foo-12345`,
    `url:${base}/stellen/stellensuche/foo-12345`,
    `url:${base}/stellen/jobsuche/foo-12345`,
    `url:${base}/stellen/suchen-und-bewerben/foo-12345`,
    `url:${base}/emplois/recherche/foo-12345`,
    `url:${base}/jobs/ricerca/foo-12345`,
    // Parameters and fragments go through the same normalisation.
    `url:${base}/view?%6AobId=123456`,
    `url:${base}/view?jobId=%2531%32%33456`,
    `url:${base}/view?jobId=123456&next=%2541`,
    `url:${base}/view?jobId=123456&bad=%E0%A4%A`,
    `url:${base}/view?jobId=a%2F123456`,
    `url:${base}/it/jobs#/jobs/%73earch/foo-12345`,
    `url:${base}/it/jobs#/jobs/Search-Results/foo-12345`,
    `url:${base}/it/jobs#jobId=%2531%32%33456`,
    `url:${base}/it/jobs#/jobs/foo-12345?x=%2541`,
    // Fragments.
    `url:${base}/it/search#/12345`,
    `url:${base}/it/jobs#session=${HASH}`,
    `url:${base}/it/jobs#postalCode=12345`,
    `url:${base}/it/jobs#12345`,
  ])('rejects %s', (identity) => {
    expect(hasSinglePostingToken(identity)).toBe(false);
  });

  it.each([
    `url:${base}/job/12345`,
    `url:${base}/jobs/greenhouse-keeper/${UUID}`,
    `url:${base}/en/job/22479/greenhouse-keeper`,
    `url:${base}/jobs/57681/greenhouse-keeper/job?hub=13`,
    `url:${base}/en/jobs/jr135079/greenhouse-keeper`,
    `url:${base}/job/${HASH}/greenhouse-keeper`,
    `url:${base}/jobs/greenhouse-keeper-j123456.html?sid=${HASH}`,
    `url:${base}/job/Exampletown-Greenhouse-Keeper/1416095233`,
    `url:${base}/offene-stellen/greenhouse-keeper/${UUID}`,
    `url:${base}/posti-vacanti/greenhouse-keeper/${UUID}`,
    `url:${base}/postes-vacants/greenhouse-keeper/${UUID}`,
    `url:${base}/emplois/greenhouse-keeper-123456`,
    `url:${base}/job/Z%C3%BCrich-Greenhouse-Keeper-%2880%25%29/1416095233`,
    `url:${base}/JOBS/Executive-Search-Consultant-123456`,
    `url:${base}/jobs/research-specialist_r72958/`,
    `url:${base}/en/career/jobs/job-posting-page/jid-${UUID}.html`,
    `url:${base}/view?jobId=123456&q=greenhouse+keeper%20z%C3%BCrich`,
    `url:${base}/jobs/job-details?jobId=280476573&team=231361275`,
    `url:${base}/view?id=535252897224001458`,
    `url:${base}/apply?reqId=12345`,
    `url:${base}/apply?gh_jid=1234567`,
    `url:${base}/it/jobs/#job.id=12345`,
    `url:${base}/careers#offer/123456/greenhouse-keeper`,
    `url:${base}/careers#/jobs/${UUID}`,
    'id:example-garden-123456',
  ])('accepts %s', (identity) => {
    expect(hasSinglePostingToken(identity)).toBe(true);
  });

  it('keeps the record when the shared URL only carries a token that is not the posting', () => {
    const shared = `${LISTING}?postalCode=12345`;
    const active = activeJob({ url: shared });
    const record = ghost({ sourceIdentity: `url:${shared}` });
    const result = run([active], [record]);

    expect(result.cleanedExpired).toEqual([record]);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
  });
});

describe('reconcileExpiredSlugs — the next pass of the same assembly', () => {
  it('does not push an older route out of a full bucket', () => {
    const full = Array.from({ length: 20 }, (_, index) => `old-italian-${index}-example-garden`);
    const active = activeJob({
      companyKey: 'example-garden', addressLocality: 'Exampletown',
      slug: 'serrista-esperto-example-garden-exampletown',
      slugByLocale: { it: 'serrista-esperto-example-garden-exampletown' },
      previousSlugs: [...full], previousSlugsByLocale: { it: [...full] },
    });
    const record = {
      ...META, companyKey: 'example-garden', addressLocality: 'Exampletown',
      slug: 'serrista-esperto-example-garden-exampletown-k4m2qz',
      slugByLocale: { it: 'serrista-esperto-example-garden-exampletown-k4m2qz' },
      sourceIdentity: `url:${POSTING}`,
    };

    const result = reconcileExpiredSlugs([active], [record], { dryRun: false });

    // The match is found; the full bucket is what stops the write.
    expect(result.mergedCount).toBe(1);
    expect(active.previousSlugsByLocale.it).toEqual(full);
  });
});
