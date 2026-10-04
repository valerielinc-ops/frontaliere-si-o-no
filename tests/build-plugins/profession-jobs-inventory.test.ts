import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateProfessionJobs,
  _resetProfessionJobsAggregateCache,
} from '../../build-plugins/professionJobsAggregate';
import { renderProfessionFeaturedJobsForTest } from '../../build-plugins/professionLandingsPlugin';

describe('profession landing live inventory', () => {
  it('projects every matching Ticino opening and lets the renderer interleave ads', () => {
    const root = mkdtempSync(join(tmpdir(), 'profession-jobs-inventory-'));
    const now = Date.now();
    const jobs = Array.from({ length: 7 }, (_, index) => ({
      id: `engineer-${index + 1}`,
      slug: `engineer-${index + 1}`,
      title: `Software Engineer ${index + 1}`,
      titleByLocale: { en: `Software Engineer ${index + 1}` },
      company: 'Example SA',
      companyKey: 'example-sa',
      companyDomain: 'example.ch',
      canton: 'TI',
      addressLocality: 'Lugano',
      employmentType: 'FULL_TIME',
      postedDate: new Date(now - index * 86_400_000).toISOString(),
      datePosted: new Date(now - index * 86_400_000).toISOString(),
      featured: index === 0,
    }));

    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify(jobs));

    try {
      const snapshot = aggregateProfessionJobs(root, now).ingegnere;

      expect(snapshot.liveCount).toBe(7);
      expect(snapshot.jobs).toHaveLength(7);
      expect(snapshot.featured).toHaveLength(3);
      const html = renderProfessionFeaturedJobsForTest('ingegnere', 'en', snapshot);
      expect(html.match(/<article class="jc-card/g)).toHaveLength(7);
      expect(html.match(/class="adsbygoogle"/g)).toHaveLength(2);
    } finally {
      _resetProfessionJobsAggregateCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
