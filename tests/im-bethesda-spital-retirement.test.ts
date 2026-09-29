import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;

// `im-bethesda-spital` was a prospector spec over the public Bethesda jobs page
// whose JSON-LD `identifier.value` is the Umantis vacancy id of tenant 2998 —
// the tenant the dedicated `bethesda-spital` crawler already reads. It
// published the same vacancies a second time under a mis-extracted employer
// name ("& im Bethesda Spital"), with listing-page fragment URLs and teaser
// descriptions (the only CRITICAL of the parser-quality audit, issue 5253).
const RETIRED_KEY = 'im-bethesda-spital';
const RETIRED_SOURCE_FILES = [
  'data/prospector/crawlers/im-bethesda-spital.json',
  'scripts/lib/im-bethesda-spital-job-parser.mjs',
  'scripts/update-im-bethesda-spital-jobs.mjs',
];

describe('retired duplicate crawler im-bethesda-spital', () => {
  it('cannot be scheduled or re-promoted', () => {
    const manifest = readJson<{ manifest: Array<{ slug: string }> }>('data/crawler-manifest.json');
    const assignments = readJson<{ groups: string[][] }>('data/crawler-group-assignments.json');
    const roster = readJson<{ groups: Record<string, string[]>; primarySlices: Record<string, string> }>(
      'scripts/ci/crawler-generation-roster.json',
    );
    const candidates = readJson<{
      candidates: Record<string, { status: string; crawlerKey?: string; reason?: string }>;
    }>('data/prospector/candidates.json');

    expect(manifest.manifest.some(({ slug }) => slug === RETIRED_KEY)).toBe(false);
    expect(manifest.manifest.some(({ slug }) => slug === 'bethesda-spital')).toBe(true);
    expect(assignments.groups.flat()).not.toContain(RETIRED_KEY);
    expect(Object.values(roster.groups).flat()).not.toContain(RETIRED_KEY);
    expect(roster.primarySlices).not.toHaveProperty(RETIRED_KEY);

    const candidate = candidates.candidates['recruitingapp-2998@umantis.com'];
    expect(candidate).toMatchObject({ status: 'rejected', crawlerKey: RETIRED_KEY });
    expect(candidate.reason).toContain('bethesda-spital');

    for (const relativePath of RETIRED_SOURCE_FILES) {
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(false);
    }
    for (const relativePath of [
      '.github/workflows/crawler-group-07.yml',
      '.github/workflows/crawler-group-07-logic.yml',
      '.github/corpus-workflows/crawler-group-07.yml',
    ]) {
      expect(readFileSync(resolve(ROOT, relativePath), 'utf8')).not.toContain('update-im-bethesda-spital-jobs');
    }
  });
});
