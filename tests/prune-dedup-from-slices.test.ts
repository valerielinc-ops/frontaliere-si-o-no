// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { filterSliceJobs } from '../scripts/prune-dedup-from-slices.mjs';

function job(url: string, slug: string, title = 'Engineer') {
  return {
    url,
    slug,
    title,
    company: 'Example AG',
    location: 'Zurich',
  };
}

describe('prune-dedup-from-slices membership', () => {
  it('keeps the URL when assembly repairs the source slug', () => {
    const source = job('https://jobs.example.test/a', 'legacy-slug');
    const assembled = job(source.url, 'canonical-slug');

    expect(filterSliceJobs([source], [assembled])).toEqual([source]);
  });

  it('still removes a true cross-crawler duplicate with a different URL', () => {
    const duplicate = job('https://jobs.example.test/duplicate', 'duplicate-slug');
    const retained = job('https://other.example.test/engineer', 'retained-slug');

    expect(filterSliceJobs([duplicate, retained], [retained])).toEqual([retained]);
  });
});
