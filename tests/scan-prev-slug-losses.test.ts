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
import { diffJobSlices } from '../scripts/scan-prev-slug-losses.mjs';

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
