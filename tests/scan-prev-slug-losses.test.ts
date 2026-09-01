/**
 * Regression tests for #3411: scan-prev-slug-losses.mjs's per-commit diff
 * used to build `Map(prev.jobs.map(j => [j.id, j]))`. Several dedicated
 * crawlers (ferrovia-retica, julius-baer, mikron, relewant,
 * swiss-medical-network, casale) commit per-crawler slice files where
 * `.id` is never stamped — it's only added at data/jobs.json assembly
 * time, not written back onto the committed slice. When every job in a
 * slice has `.id === undefined`, the diff Map collapsed them all onto a
 * single `undefined` key, so lookups returned an arbitrary sibling job
 * instead of missing — corrupting the "lost slug" diff into garbage
 * inflated counts instead of a clean skip.
 *
 * diffJobSlices() now resolves jobs via resolveJobDiffKey() (real `.id` >
 * stable URL-derived key > slug), so id-less slices diff correctly instead
 * of colliding.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCrossJobDecontamination,
  classifyJobSliceRemovals,
  diffJobSlices,
  formatJsonLines,
} from '../scripts/scan-prev-slug-losses.mjs';
import { stableSlugHash } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('diffJobSlices', () => {
  it('detects a lost slug for a normal job with .id present', () => {
    const prev = [
      { id: 'company-aaa', slug: 'job-a', previousSlugs: ['job-a-old'] },
    ];
    const cur = [
      { id: 'company-aaa', slug: 'job-a' }, // 'job-a-old' silently dropped
    ];
    const result = diffJobSlices(prev, cur);
    expect(result).toHaveLength(1);
    expect(result[0].jobKey).toBe('company-aaa');
    expect(result[0].lost).toEqual(['job-a-old']);
  });

  it('reports no loss when previousSlugs survive the diff', () => {
    const prev = [
      { id: 'company-aaa', slug: 'job-a', previousSlugs: ['job-a-old'] },
    ];
    const cur = [
      { id: 'company-aaa', slug: 'job-a', previousSlugs: ['job-a-old'] },
    ];
    expect(diffJobSlices(prev, cur)).toHaveLength(0);
  });

  it('does not collide id-less jobs onto a shared undefined key (the #3411 bug)', () => {
    // Mirrors ferrovia-retica.json: every job in the slice has no `.id`,
    // only a `url` and `slug`. Two distinct jobs, each losing its own
    // distinct previousSlugs entry between commits.
    const prev = [
      { url: 'https://www.rhb.ch/it/job/job-a/', slug: 'job-a', previousSlugs: ['job-a-old'] },
      { url: 'https://www.rhb.ch/it/job/job-b/', slug: 'job-b', previousSlugs: ['job-b-old'] },
    ];
    const cur = [
      { url: 'https://www.rhb.ch/it/job/job-a/', slug: 'job-a' },
      { url: 'https://www.rhb.ch/it/job/job-b/', slug: 'job-b' },
    ];

    const result = diffJobSlices(prev, cur);

    // Before the fix: both jobs collided under Map key `undefined`, so
    // byId.get(undefined) always resolved to job-b (the last one inserted)
    // — job-a would incorrectly diff against job-b's before-state, and the
    // real per-job attribution was lost/garbled.
    expect(result).toHaveLength(2);
    const byKey = new Map(result.map(r => [r.jobKey, r.lost]));
    expect(byKey.get('url:https://www.rhb.ch/it/job/job-a')).toEqual(['job-a-old']);
    expect(byKey.get('url:https://www.rhb.ch/it/job/job-b')).toEqual(['job-b-old']);
    // Distinct keys, not the collided `undefined`.
    expect(new Set(result.map(r => r.jobKey)).size).toBe(2);
  });

  it('does not fabricate a loss for an id-less job with no prior counterpart', () => {
    const prev = [
      { url: 'https://www.rhb.ch/it/job/job-a/', slug: 'job-a', previousSlugs: ['job-a-old'] },
    ];
    const cur = [
      { url: 'https://www.rhb.ch/it/job/job-a/', slug: 'job-a' },
      { url: 'https://www.rhb.ch/it/job/job-c/', slug: 'job-c' }, // brand-new job, no prior version
    ];
    const result = diffJobSlices(prev, cur);
    expect(result).toHaveLength(1);
    expect(result[0].jobKey).toBe('url:https://www.rhb.ch/it/job/job-a');
  });

  it('falls back to slug matching when neither id nor url is present', () => {
    const prev = [
      { slug: 'job-a', previousSlugs: ['job-a-old'] },
    ];
    const cur = [
      { slug: 'job-a' },
    ];
    const result = diffJobSlices(prev, cur);
    expect(result).toHaveLength(1);
    expect(result[0].jobKey).toBe('slug:job-a');
  });

  it('skips jobs with no id, url, or slug on either side instead of crashing', () => {
    const prev = [{ previousSlugs: ['orphan-old'] }];
    const cur = [{}];
    expect(diffJobSlices(prev, cur)).toHaveLength(0);
  });

  it('accounts for previousSlugsByLocale and slugByLocale in before/after sets', () => {
    const prev = [
      {
        id: 'company-bbb',
        slugByLocale: { it: 'lavoro-it', en: 'job-en' },
        previousSlugsByLocale: { it: ['lavoro-it-old'] },
      },
    ];
    const cur = [
      {
        id: 'company-bbb',
        slugByLocale: { it: 'lavoro-it', en: 'job-en' },
        // 'lavoro-it-old' dropped from both previousSlugsByLocale and previousSlugs
      },
    ];
    const result = diffJobSlices(prev, cur);
    expect(result).toHaveLength(1);
    expect(result[0].lost).toEqual(['lavoro-it-old']);
  });

  it('returns no results for empty or malformed input arrays', () => {
    expect(diffJobSlices([], [])).toHaveLength(0);
    expect(diffJobSlices(null as unknown as unknown[], [])).toHaveLength(0);
    expect(diffJobSlices([], null as unknown as unknown[])).toHaveLength(0);
  });
});

// Regression tests for #4368 (and its duplicate predecessors #4226/#4243/
// #4249/#4289/#4326): the tripwire fired continuously for days because this
// scanner did a plain before/after set diff with no notion of the documented
// per-locale/legacy cap in dedicated-crawler-common.mjs's
// addPreviousSlugForLocale/capSlugArray, so routine, already-journaled
// cap-trim (evicting the oldest entry once an array exceeds its cap) looked
// identical to a silent-bypass code bug. Confirmed against real data: 91% of
// a 48h sample's "losses" were coop-ticino.json's flat legacy `previousSlugs`
// array (a large pre-migration backlog) catching up to its cap, while every
// per-locale array stayed healthy and within cap.
describe('diffJobSlices cap-trim awareness', () => {
  it('does not flag a per-locale loss that the cap fully explains', () => {
    const prev = [
      {
        id: 'company-aaa',
        slugByLocale: { it: 'job-c' },
        previousSlugsByLocale: { it: ['job-a', 'job-b'] }, // at cap (2)
      },
    ];
    const cur = [
      {
        id: 'company-aaa',
        slugByLocale: { it: 'job-c' },
        // 'job-b' captured on rename, cap=2 evicts oldest ('job-a')
        previousSlugsByLocale: { it: ['job-b', 'job-c-prior'] },
      },
    ];
    const result = diffJobSlices(prev, cur, { perLocaleCap: 2, locales: ['it'] });
    expect(result).toHaveLength(0);
  });

  it('does not flag a flat legacy-array loss that the cap fully explains', () => {
    const prev = [
      { id: 'company-bbb', slug: 'job-c', previousSlugs: ['job-a', 'job-b'] }, // at legacy cap (2)
    ];
    const cur = [
      { id: 'company-bbb', slug: 'job-c', previousSlugs: ['job-b', 'job-d'] }, // 'job-a' evicted, 'job-d' added
    ];
    const result = diffJobSlices(prev, cur, { perLocaleCap: 2, locales: ['it'] });
    expect(result).toHaveLength(0);
  });

  it('still flags losses beyond what the cap can explain', () => {
    const prev = [
      {
        id: 'company-ccc',
        previousSlugsByLocale: { it: ['job-a', 'job-b'] }, // at cap (2)
      },
    ];
    const cur = [
      {
        id: 'company-ccc',
        // Both entries gone, but only one new capture this cycle — the cap
        // can only explain evicting one oldest entry, not both.
        previousSlugsByLocale: { it: ['job-c'] },
      },
    ];
    const result = diffJobSlices(prev, cur, { perLocaleCap: 2, locales: ['it'] });
    expect(result).toHaveLength(1);
    // 'job-a' (oldest) is cap-explained; 'job-b' vanishing too is the part
    // the cap can't account for and stays flagged.
    expect(result[0].lost).toEqual(['job-b']);
  });

  it('still flags a loss when the array was under cap (no eviction possible)', () => {
    const prev = [
      { id: 'company-ddd', previousSlugsByLocale: { it: ['job-a'] } }, // 1 entry, cap is 20
    ];
    const cur = [
      { id: 'company-ddd', previousSlugsByLocale: { it: [] } },
    ];
    const result = diffJobSlices(prev, cur);
    expect(result).toHaveLength(1);
    expect(result[0].lost).toEqual(['job-a']);
  });
});

describe('safe cross-job decontamination classification (#5348)', () => {
  const ownerUrl = 'https://owner.example/jobs/11111111-1111-1111-1111-111111111111';
  const ownerHash = stableSlugHash({ url: ownerUrl });
  const slug = `senior-engineer-real-owner-zurich-${ownerHash}`;
  const claimantBefore = {
    id: 'claimant',
    url: 'https://claimant.example/jobs/22222222-2222-2222-2222-222222222222',
    slug: 'claimant-current',
    previousSlugs: [slug],
  };
  const claimantAfter = { ...claimantBefore, previousSlugs: [] };
  const owner = { id: 'stable-owner', url: ownerUrl, slug };

  function removal() {
    return classifyJobSliceRemovals([claimantBefore], [claimantAfter])[0];
  }

  it('excludes only a historical claimant alias already and still owned by one stable job', () => {
    const result = classifyCrossJobDecontamination(
      removal(),
      [claimantBefore, owner],
      [claimantAfter, owner],
    );
    expect(result.lost).toEqual([]);
    expect(result.safeCrossJobDecontaminations).toEqual([
      { slug, ownerJobId: 'stable-owner' },
    ]);
  });

  it('keeps a real same-job loss recoverable and never treats an active-route drop as cleanup', () => {
    expect(classifyCrossJobDecontamination(
      removal(),
      [claimantBefore],
      [claimantAfter],
    )).toEqual({ lost: [slug], safeCrossJobDecontaminations: [] });

    const activeBefore = { id: 'claimant', slug };
    const activeAfter = { id: 'claimant', slug: 'claimant-new' };
    const activeRemoval = classifyJobSliceRemovals([activeBefore], [activeAfter])[0];
    expect(classifyCrossJobDecontamination(
      activeRemoval,
      [activeBefore, owner],
      [activeAfter, owner],
    )).toEqual({ lost: [slug], safeCrossJobDecontaminations: [] });
  });

  it.each([
    {
      name: 'collisione preesistente',
      before: [claimantBefore, owner, { id: 'second-owner', url: ownerUrl, previousSlugs: [slug] }],
      after: [claimantAfter, owner, { id: 'second-owner', url: ownerUrl, previousSlugs: [slug] }],
    },
    {
      name: 'owner swap',
      before: [claimantBefore, owner],
      after: [claimantAfter, { id: 'replacement-owner', url: ownerUrl, slug }],
    },
    {
      name: 'route non più raggiungibile',
      before: [claimantBefore, owner],
      after: [claimantAfter],
    },
    {
      name: 'stringa presente altrove senza claimant nel parent',
      before: [owner],
      after: [owner],
    },
  ])('fails closed on $name', ({ before, after }) => {
    expect(classifyCrossJobDecontamination(removal(), before, after)).toEqual({
      lost: [slug],
      safeCrossJobDecontaminations: [],
    });
  });

  it('uses the active+expired owner union and is idempotent', () => {
    const activeBefore = [claimantBefore];
    const activeAfter = [claimantAfter];
    const expiredBefore = [{ id: 'stable-owner', url: ownerUrl, previousSlugsByLocale: { de: [slug] } }];
    const expiredAfter = [{ id: 'stable-owner', url: ownerUrl, previousSlugsByLocale: { de: [slug] } }];
    const inputBefore = [...activeBefore, ...expiredBefore];
    const inputAfter = [...activeAfter, ...expiredAfter];
    const event = removal();
    const snapshot = JSON.stringify({ event, inputBefore, inputAfter });

    const first = classifyCrossJobDecontamination(event, inputBefore, inputAfter);
    const second = classifyCrossJobDecontamination(event, inputBefore, inputAfter);
    expect(second).toEqual(first);
    expect(JSON.stringify({ event, inputBefore, inputAfter })).toBe(snapshot);
    expect(classifyJobSliceRemovals(activeAfter, activeAfter)).toEqual([]);
  });

  it('has explicit zero/absent-input outputs instead of manufacturing an event', () => {
    expect(classifyCrossJobDecontamination(
      { jobKey: 'claimant', lost: [], historicalLost: [] },
      undefined as unknown as object[],
      undefined as unknown as object[],
    )).toEqual({ lost: [], safeCrossJobDecontaminations: [] });
    expect(formatJsonLines([])).toBe('');
    expect(formatJsonLines(undefined as unknown as object[])).toBe('');
  });

  it('classifies the 121-event #6909 shape as safe, split across active and expired owners', () => {
    const owners = Array.from({ length: 121 }, (_, i) => {
      const url = `https://owner.example/jobs/stable-posting-identifier-${String(i).padStart(6, '0')}`;
      return { id: `owner-${i}`, url, slug: `cross-job-alias-${i}-${stableSlugHash({ url })}` };
    });
    expect(new Set(owners.map((job) => stableSlugHash(job))).size).toBe(121);
    const claimantsBefore = owners.map((ownerJob, i) => ({
      id: `claimant-${i}`,
      url: `https://claimant.example/jobs/stable-posting-identifier-${String(i).padStart(6, '0')}`,
      slug: `claimant-current-${i}`,
      previousSlugs: [ownerJob.slug],
    }));
    const claimantsAfter = claimantsBefore.map(({ previousSlugs: _removed, ...job }) => job);
    const activeOwners = owners.slice(0, 61);
    const expiredOwners = owners.slice(61).map(({ slug: route, ...job }) => ({
      ...job,
      previousSlugs: [route],
    }));
    const beforeUniverse = [...claimantsBefore, ...activeOwners, ...expiredOwners];
    const afterUniverse = [...claimantsAfter, ...activeOwners, ...expiredOwners];
    const removals = classifyJobSliceRemovals(claimantsBefore, claimantsAfter);

    const classified = removals.map((event) => (
      classifyCrossJobDecontamination(event, beforeUniverse, afterUniverse)
    ));
    expect(classified.flatMap((event) => event.lost)).toEqual([]);
    expect(classified.flatMap((event) => event.safeCrossJobDecontaminations)).toHaveLength(121);
  });
});
