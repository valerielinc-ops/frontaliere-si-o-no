import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveRetiredMyJobs } from '../scripts/migrate-retired-my-crawler.mjs';

const ROOT = process.cwd();
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;

// Issue 5253: `my` was keyed on the host label of my.jobalino.ch, shared by
// six prospector candidates. The dedicated Teo Jakob parser now owns the key;
// the old Bellevue/Fanzun records remain covered by the soft-landing test below.
describe('active crawler my', () => {
  it('is scheduled with its dedicated parser', () => {
    const manifest = readJson<{ manifest: Array<{ slug: string }> }>('data/crawler-manifest.json');
    const assignments = readJson<{ groups: string[][] }>('data/crawler-group-assignments.json');
    const roster = readJson<{ groups: Record<string, string[]>; primarySlices: Record<string, string> }>(
      'scripts/ci/crawler-generation-roster.json',
    );
    expect(manifest.manifest.some(({ slug }) => slug === 'my')).toBe(true);
    expect(assignments.groups.flat()).toContain('my');
    expect(Object.values(roster.groups).flat()).toContain('my');
    expect(roster.primarySlices).toHaveProperty('my');
    for (const relativePath of ['scripts/lib/my-job-parser.mjs', 'scripts/update-my-jobs.mjs']) {
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(true);
    }
    for (const relativePath of [
      '.github/workflows/crawler-group-23.yml',
      '.github/workflows/crawler-group-23-logic.yml',
      '.github/corpus-workflows/crawler-group-23.yml',
    ]) {
      expect(readFileSync(resolve(ROOT, relativePath), 'utf8')).toContain('update-my-jobs');
    }
  });

  it('keeps every published route as an expired soft landing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retire-my-'));
    try {
      const record = {
        id: 'my-1',
        title: 'Initiativbewerbung / 80% - 100%',
        company: 'Bellevue Parkhotel & Spa',
        companyKey: 'my',
        url: 'https://my.jobalino.ch/job/ec70e0c43b72e9a77a115bb9c8e77542/fanzun-ag/initiativbewerbung_1048',
        slug: 'applicazione-iniziativa-80-100-bellevue-parkhotel-spa-chur',
        slugByLocale: {
          it: 'applicazione-iniziativa-80-100-bellevue-parkhotel-spa-chur',
          de: 'initiativbewerbung-80-100-chur-my-ch',
        },
        location: 'Chur',
      };
      const result = archiveRetiredMyJobs([record], dir);
      expect(result.archived).toBe(1);
      expect(result.routesAfter).toBe(result.routesBefore);
      const archive = JSON.parse(readFileSync(join(dir, 'my.json'), 'utf8'));
      expect(archive[0]).toMatchObject({ slug: record.slug, companyKey: 'my' });
      expect(Number.isNaN(Date.parse(archive[0].expiredAt))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
