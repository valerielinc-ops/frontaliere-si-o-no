import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadLocalJobsData } from '../scripts/send-newsletter.mjs';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-local-jobs-'));
  tempRoots.push(root);
  const slicesDirPath = path.join(root, 'by-crawler');
  fs.mkdirSync(slicesDirPath);
  return {
    jobsPath: path.join(root, 'jobs.json'),
    slicesDirPath,
    statsPath: path.join(root, 'jobs-stats.json'),
  };
}

describe('loadLocalJobsData fallback completeness', () => {
  it('rejects the whole fallback when a later crawler slice is malformed', () => {
    const paths = fixtureRoot();
    fs.writeFileSync(paths.jobsPath, '{ not json', 'utf8');
    fs.writeFileSync(
      path.join(paths.slicesDirPath, 'a-good.json'),
      JSON.stringify({ jobs: [{ id: 'first', title: 'First vacancy' }] }),
      'utf8',
    );
    fs.writeFileSync(path.join(paths.slicesDirPath, 'z-bad.json'), '{ not json', 'utf8');

    expect(() => loadLocalJobsData(paths)).toThrow(/Local jobs load incomplete.*z-bad\.json/);
  });

  it('rejects a structurally invalid crawler slice instead of skipping it', () => {
    const paths = fixtureRoot();
    fs.writeFileSync(paths.jobsPath, '[]', 'utf8');
    fs.writeFileSync(path.join(paths.slicesDirPath, 'broken.json'), JSON.stringify({ jobs: {} }), 'utf8');

    // A valid assembled dataset is authoritative, so an invalid unused slice
    // does not make this path incomplete.
    expect(loadLocalJobsData(paths).jobs).toEqual([]);

    fs.writeFileSync(paths.jobsPath, '{ not json', 'utf8');
    expect(() => loadLocalJobsData(paths)).toThrow(/invalid crawler slice shape in broken\.json/);
  });

  it('uses all valid slices when the assembled file is unavailable', () => {
    const paths = fixtureRoot();
    fs.writeFileSync(
      path.join(paths.slicesDirPath, 'a-jobs.json'),
      JSON.stringify({ jobs: [{ id: 'first', title: 'First vacancy' }] }),
      'utf8',
    );

    expect(loadLocalJobsData(paths).jobs).toMatchObject([{ id: 'first', title: 'First vacancy' }]);
  });
});
