// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { filterSliceJobs, pruneDedupFromSlices } from '../scripts/prune-dedup-from-slices.mjs';

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

  it('retains an assembly-only omission when no duplicate proof exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'prune-dedup-proof-'));
    const slicesDir = join(root, 'data', 'jobs', 'by-crawler');
    const duplicate = job('https://jobs.example.test/duplicate', 'duplicate-slug');
    const retained = job('https://other.example.test/engineer', 'retained-slug');
    const assemblyOnlyOmission = job('https://jobs.example.test/filtered', 'filtered-slug', 'Unique position');
    try {
      mkdirSync(slicesDir, { recursive: true });
      writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify([retained]));
      writeFileSync(
        join(slicesDir, 'example.json'),
        JSON.stringify({ crawlerKey: 'example', jobs: [duplicate, retained, assemblyOnlyOmission] }),
      );

      expect(pruneDedupFromSlices(root)).toMatchObject({ totalPruned: 1, modifiedSlices: 1 });
      const output = JSON.parse(readFileSync(join(slicesDir, 'example.json'), 'utf8'));
      expect(output.jobs).toEqual([retained, assemblyOnlyOmission]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
