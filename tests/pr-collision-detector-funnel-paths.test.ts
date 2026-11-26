import { describe, expect, it } from 'vitest';
import { isFunnel } from '../scripts/ci/pr-collision-detector.mjs';

describe('pr-collision-detector funnel-critical path classes', () => {
  it.each([
    'scripts/assisted-application/agent.mjs',
    'scripts/assisted-application/lib/portal/fields.mjs',
    'scripts/mine-all-job-slugs.mjs',
    'data/jobs/by-crawler/galenica.json',
    'data/jobs/by-crawler/shards/galenica-001.json',
  ])('includes the observed hand-off class: %s', (file) => {
    expect(isFunnel(file)).toBe(true);
  });

  it.each([
    'scripts/assisted-application.mjs',
    'scripts/assisted-applications/agent.mjs',
    'scripts/mine-all-job-slugs.ts',
    'scripts/mine-job-slugs.mjs',
    'data/jobs/by-crawler.json',
    'data/jobs/expired/by-crawler/galenica.json',
    'data/jobs-crawler-summaries/by-crawler/galenica.json',
    'data/jobs/by-company/galenica.json',
    'services/jobs/jobStore.ts',
  ])('does not widen to the lexical neighbour: %s', (file) => {
    expect(isFunnel(file)).toBe(false);
  });

  it('keeps the pre-existing explicit funnel classes', () => {
    expect(isFunnel('scripts/lib/prComments.mjs')).toBe(true);
    expect(isFunnel('build-plugins/jobPagesPlugin.ts')).toBe(true);
    expect(isFunnel('services/seo/jobSeo.ts')).toBe(true);
    expect(isFunnel('.github/workflows/tests.yml')).toBe(true);
    expect(isFunnel('scripts/update-example-jobs.mjs')).toBe(true);
  });
});
