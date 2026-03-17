import { describe, expect, it } from 'vitest';

import { computeCrawlDiff, snapshotJobSlugs } from '../scripts/jobs-url-helper.mjs';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: String(overrides.id || 'job-id'),
    slug: String(overrides.slug || overrides.id || 'job-id'),
    url: String(overrides.url || `https://example.com/${overrides.id || 'job-id'}`),
    title: String(overrides.title || 'Software Engineer'),
    company: String(overrides.company || 'ReleWant'),
    location: String(overrides.location || 'Bellinzona'),
    description: String(overrides.description || 'Descrizione iniziale'),
    titleByLocale: overrides.titleByLocale || {},
    descriptionByLocale: overrides.descriptionByLocale || {},
    slugByLocale: overrides.slugByLocale || {},
    ...overrides,
  };
}

describe('jobs-url-helper crawl diff', () => {
  it('treats a slug rename on the same source URL as an update', () => {
    const beforeSnapshot = snapshotJobSlugs([
      job({
        id: 'job-bi',
        slug: 'bi-specialist-relewant-bellinzona',
        url: 'https://relewant.com/jobs/bi-specialist',
        title: 'BI Specialist',
        titleByLocale: { it: 'BI Specialist' },
        slugByLocale: { it: 'bi-specialist-relewant-bellinzona' },
      }),
    ]);

    const afterSnapshot = snapshotJobSlugs([
      job({
        id: 'job-bi',
        slug: 'specialista-della-bi-relewant-bellinzona',
        url: 'https://relewant.com/jobs/bi-specialist',
        title: 'Specialista della BI',
        titleByLocale: { it: 'Specialista della BI' },
        slugByLocale: { it: 'specialista-della-bi-relewant-bellinzona' },
      }),
    ]);

    const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);

    expect(diff.newJobs).toHaveLength(0);
    expect(diff.removedJobs).toHaveLength(0);
    expect(diff.updatedJobs).toHaveLength(1);
    expect(diff.unchangedCount).toBe(0);
  });

  it('uses the stable job id when url is missing and slug changes', () => {
    const beforeSnapshot = snapshotJobSlugs([
      job({
        id: 'job-123',
        url: '',
        slug: 'junior-bi-specialist',
        title: 'Junior BI Specialist',
      }),
    ]);

    const afterSnapshot = snapshotJobSlugs([
      job({
        id: 'job-123',
        url: '',
        slug: 'specialista-junior-bi',
        title: 'Specialista Junior BI',
      }),
    ]);

    const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);

    expect(diff.newJobs).toHaveLength(0);
    expect(diff.removedJobs).toHaveLength(0);
    expect(diff.updatedJobs).toHaveLength(1);
  });
});
