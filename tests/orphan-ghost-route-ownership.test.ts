/**
 * Two ways the assembly could still lose or misassign job URLs.
 *
 * 1. `reconcileOrphanSlugs` pushed the oldest route out of a full per-locale
 *    bucket to make room for a recovered orphan.
 * 2. The ghost pass (and the expired pass after it) handed an archive record's
 *    current and flat slugs to an active job matched only through merge history
 *    or through a URL that stops naming one posting once its fragment is cut.
 *
 * All fixtures are invented.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileGhostExpired } from '../scripts/assemble-jobs-dataset.mjs';
import { reconcileExpiredSlugs, reconcileOrphanSlugs, updateCrawlerSlices } from '../scripts/reconcile-job-slugs.mjs';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';
import { createPostingProof } from '../scripts/lib/ghost-route-transfer.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-ghost-routes-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BASE = 'https://careers.example-garden.test/jobs/greenhouse-keeper';
const POSTING = `${BASE}/7f3c9a2e-5b41-4d8e-9c02-6a1b2c3d4e5f`;
const OTHER = `${BASE}/0b9d8c7a-1e2f-4a3b-8c9d-0e1f2a3b4c5d`;
const META = { title: 'Greenhouse Keeper', company: 'Example Garden', location: 'Exampletown' };
const LIVE = 'greenhouse-keeper-example-garden-exampletown';
const ORPHAN = 'greenhouse-keeper-example-garden-exampletown-old';
const numbered = (prefix: string, length: number) =>
  Array.from({ length }, (_, index) => `${prefix}-${index}-example-garden`);

type Job = Record<string, any>;

const activeJob = (overrides: Job = {}): Job => ({
  ...META, companyKey: 'example-garden', id: 'example-garden-1', url: POSTING,
  slug: LIVE, slugByLocale: { it: LIVE }, ...overrides,
});

const ghost = (overrides: Job = {}): Job => ({
  ...META, companyKey: 'example-garden',
  slug: LIVE,
  slugByLocale: { it: LIVE, en: 'sibling-keeper-en-example-garden', de: 'sibling-keeper-de-example-garden' },
  previousSlugs: ['sibling-keeper-legacy-example-garden'],
  sourceIdentity: `url:${POSTING}`,
  ...overrides,
});

const ghostPass = (active: Job[], expired: Job[]) => {
  const before = new Set([...active, ...expired].flatMap((job) => [...localeRouteKeys(job)]));
  const result = reconcileGhostExpired(active, expired, { sliceDir: tmp });
  const after = new Set([...active, ...result.cleanedExpired].flatMap((job: Job) => [...localeRouteKeys(job)]));
  expect([...before].filter((route) => !after.has(route))).toEqual([]);
  return result;
};

describe('reconcileOrphanSlugs — no eviction', () => {
  const run = (job: Job, enriched: Job = {}) => {
    const before = [...localeRouteKeys(job)];
    const result = reconcileOrphanSlugs([job], [ORPHAN], [{
      slug: ORPHAN, companyKey: 'example-garden', sourceUrl: POSTING, ...enriched,
    }]);
    expect(before.filter((route) => !localeRouteKeys(job).has(route))).toEqual([]);
    return result;
  };

  it('keeps a full locale bucket whole and leaves the orphan in the ledger', () => {
    const full = numbered('old-italian', 20);
    const job = activeJob({ previousSlugs: [...full], previousSlugsByLocale: { it: [...full] } });
    const result = run(job);

    expect(job.previousSlugsByLocale.it).toEqual(full);
    expect(result.mergedCount).toBe(0);
    expect(result.remainingOrphans).toEqual([ORPHAN]);
    expect(result.updatedJobs.size).toBe(0);
  });

  it('keeps a full flat union whole', () => {
    const flat = numbered('old-flat', 80);
    const job = activeJob({ previousSlugs: [...flat] });
    const result = run(job);

    expect(job.previousSlugs).toEqual(flat);
    expect(result.remainingOrphans).toEqual([ORPHAN]);
  });

  it('does not evict for a cross-locale slug from the enrichment', () => {
    const full = numbered('old-french', 20);
    const job = activeJob({ previousSlugs: [...full], previousSlugsByLocale: { fr: [...full] } });
    const result = run(job, { slugByLocale: { fr: 'gardien-de-serre-example-garden' } });

    expect(job.previousSlugsByLocale.fr).toEqual(full);
    expect(job.previousSlugsByLocale.it).toEqual([ORPHAN]);
    expect(result.mergedCount).toBe(1);
    expect(result.remainingOrphans).toEqual([]);
  });
});

describe('updateCrawlerSlices — writing the merge back evicts nothing', () => {
  it('keeps every slice route, including a bucket already over the cap', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'active-'));
    const over = numbered('old-italian', 23);
    const flat = [...over, ...numbered('old-flat', 56)];
    const file = path.join(dir, 'example-garden.json');
    fs.writeFileSync(file, JSON.stringify({
      jobs: [activeJob({ previousSlugs: [...flat], previousSlugsByLocale: { it: [...over] } })],
    }));
    const updated = activeJob({
      previousSlugs: ['new-flat-a', 'new-flat-b'],
      previousSlugsByLocale: { it: ['new-italian'], fr: ['new-french'] },
    });

    updateCrawlerSlices(new Map([['k', updated]]), { slicesDir: dir });

    const [job] = JSON.parse(fs.readFileSync(file, 'utf8')).jobs;
    expect(job.previousSlugsByLocale.it).toEqual(over);
    expect(job.previousSlugsByLocale.fr).toEqual(['new-french']);
    expect(job.previousSlugs).toEqual([...flat, 'new-french']);
  });
});

describe('ghost pass — current and flat slugs need the posting each record declares itself', () => {
  const FOREIGN = ['sibling-keeper-en-example-garden', 'sibling-keeper-de-example-garden', 'sibling-keeper-legacy-example-garden'];
  const gained = (job: Job) => FOREIGN.filter((slug) => [...localeRouteKeys(job)].some((route) => route.endsWith(`:${slug}`)));

  it.each([
    ['merge history of the archive record', {}, { sourceIdentity: `url:${OTHER}`, sourceIdentityHistory: [{ sourceIdentity: `url:${POSTING}` }] }],
    ['merge history of the active job', { sourceIdentityHistory: [{ sourceIdentity: `url:${OTHER}` }] }, { sourceIdentity: `url:${OTHER}` }],
    ['a listing URL whose fragment names the posting', { url: 'https://careers.example-garden.test/jobs#job.id=222222' }, { sourceIdentity: undefined, url: 'https://careers.example-garden.test/jobs#job.id=111111' }],
    ['a raw crawler id', { id: 'listing-derived' }, { id: 'listing-derived', sourceIdentity: `url:${OTHER}` }],
  ])('assigns nothing on %s, and keeps the record', (_label, activeOverrides, ghostOverrides) => {
    const active = activeJob(activeOverrides);
    const record = ghost(ghostOverrides);
    const result = ghostPass([active], [record]);

    expect(gained(active)).toEqual([]);
    expect(result.mergedSlugs).toBe(0);
    expect(result.cleanedExpired).toEqual([record]);
  });

  it('assigns nothing when two titles declare the same URL', () => {
    const listing = 'https://careers.example-garden.test/it/jobs';
    const active = activeJob({ url: listing });
    const record = ghost({ sourceIdentity: `url:${listing}` });
    const third = { ...META, title: 'Orchard Foreman', slug: 'capo-frutteto-example-garden', sourceIdentity: `url:${listing}` };
    ghostPass([active], [record, third]);

    expect(gained(active)).toEqual([]);
  });

  it.each([
    ['the same URL', POSTING, POSTING],
    ['a URL that differs by the trailing slash', `${POSTING}/`, POSTING],
    ['an exclusive URL without a numeric token', `${BASE}-title-only`, `${BASE}-title-only`],
  ])('still assigns them on %s', (_label, activeUrl, ghostUrl) => {
    const active = activeJob({ url: activeUrl });
    const result = ghostPass([active], [ghost({ sourceIdentity: `url:${ghostUrl}` })]);

    expect(gained(active)).toEqual(FOREIGN);
    expect(result.cleanedExpired).toEqual([]);
  });

  it('the expired pass of the same assembly does not undo it through the history URL', () => {
    const active = activeJob({
      addressLocality: 'Exampletown', slug: 'serrista-esperto-example-garden-exampletown',
      slugByLocale: { it: 'serrista-esperto-example-garden-exampletown' },
    });
    const record = {
      ...META, companyKey: 'example-garden', addressLocality: 'Exampletown',
      slug: 'serrista-esperto-example-garden-exampletown-k4m2qz',
      slugByLocale: { it: 'serrista-esperto-example-garden-exampletown-k4m2qz' },
      sourceIdentity: `url:${OTHER}`,
      sourceIdentityHistory: [{ sourceIdentity: `url:${POSTING}` }],
    };

    const result = reconcileExpiredSlugs([active], [record], { dryRun: false });

    expect(result.mergedCount).toBe(0);
    expect(result.updatedExpired).toEqual([record]);
    expect(active).not.toHaveProperty('previousSlugsByLocale');
  });
});

describe('createPostingProof — metadata tuples never collide', () => {
  it('sees a third declarer whose delimiter-bearing fields spell the same joined text', () => {
    const [archived, active, third] = [
      ['Engineer||Field', 'Coop', 'Ticino'],
      ['Engineer', 'Field||Coop', 'Ticino'],
      ['Engineer', 'Field', 'Coop||Ticino'],
    ].map(([title, company, location]) => ({ title, company, location, sourceIdentity: 'id:123456' }));

    expect(createPostingProof([active], [archived, third]).sameDeclaredPosting(archived, active)).toBe(false);
  });
});
