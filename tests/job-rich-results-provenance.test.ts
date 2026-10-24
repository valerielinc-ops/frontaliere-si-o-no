import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SECTION_LEGACY_TI } from '../build-plugins/shared/cantonResolvers.mjs';

const script = resolve('scripts/validate-jobs-rich-results-sample.mjs');
const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const posting = {
  '@type': 'JobPosting', title: 'Infermiere', description: 'Assistenza ai pazienti.',
  datePosted: date, validThrough: new Date(Date.now() + 30 * 86400000).toISOString(), employmentType: 'FULL_TIME',
  hiringOrganization: { name: 'Example SA' },
  jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900', streetAddress: 'Via Test 1' } },
  baseSalary: { currency: 'CHF', value: { minValue: 70000, maxValue: 90000, unitText: 'YEAR' } },
};
// The source record the posting above was built from: every optional field
// of the posting exists here (owner decision 2026-10-24: present iff stated).
const SOURCE_FIELDS: Record<string, unknown> = {
  validThrough: posting.validThrough,
  salaryMin: 70000,
  salaryMax: 90000,
  salarySource: 'reported',
  employmentType: 'FULL_TIME',
  postalCode: '6900',
  streetAddress: 'Via Test 1',
};
function validate(
  source: string | undefined,
  schema: Record<string, unknown> | null,
  overrides: {
    firstSeenAt?: string;
    crawledAt?: string;
    postedDate?: string;
    canonicalUrlByLocale?: Record<string, string>;
    schemaByLocale?: Record<string, Record<string, unknown> | null>;
    job?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'rich-result-provenance-'));
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/jobs.json'), JSON.stringify([{ slug: 'example', postingDateSource: source, postedDate: overrides.postedDate ?? date, firstSeenAt: overrides.firstSeenAt, crawledAt: overrides.crawledAt, ...(overrides.job ?? SOURCE_FIELDS) }]));
    for (const [locale, section] of Object.entries(SECTION_LEGACY_TI)) {
      const dir = join(root, 'dist', locale === 'it' ? '' : locale, section, 'example');
      mkdirSync(dir, { recursive: true });
      const localeSchema = Object.hasOwn(overrides.schemaByLocale || {}, locale)
        ? overrides.schemaByLocale?.[locale]
        : schema;
      const canonicalUrl = overrides.canonicalUrlByLocale?.[locale];
      const canonical = canonicalUrl ? `<link rel="canonical" href="${canonicalUrl}">` : '';
      writeFileSync(join(dir, 'index.html'), `<h1>Infermiere</h1>${canonical}${localeSchema ? `<script type="application/ld+json">${JSON.stringify(localeSchema)}</script>` : ''}`);
    }
    return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('rich-result eligibility validation', () => {
  // Regression of PR 11394 (2026-10-04): an unverified publication date used
  // to withhold JobPosting and the validator counted that as success.
  it.each([undefined, 'unknown'])('rejects an active page without JobPosting even when provenance is %s', (source) => {
    const result = validate(source, null);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('jobposting_missing');
  });
  it('accepts a first-seen fallback when the record carries its observation timestamp', () => {
    const firstSeenAt = new Date(Date.now() - 4 * 86400000).toISOString();
    const result = validate('unknown', { ...posting, datePosted: firstSeenAt }, { firstSeenAt });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('JobPosting first-seen dates: 4');
    expect(result.stdout).toContain('Eligible locale checks: 4');
  });
  it('accepts the crawler observation when firstSeenAt is absent', () => {
    const crawledAt = new Date(Date.now() - 2 * 86400000).toISOString();
    const result = validate('unknown', { ...posting, datePosted: crawledAt }, { crawledAt });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('JobPosting observed dates: 4');
  });
  it('accepts the build date for a record without any timestamp', () => {
    const result = validate('unknown', posting, { postedDate: '' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('JobPosting build-clock dates: 4');
  });
  it('rejects a first-seen record whose page carries another date', () => {
    const firstSeenAt = new Date(Date.now() - 4 * 86400000).toISOString();
    const result = validate('unknown', posting, { firstSeenAt });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('datePosted:first-seen_mismatch');
  });
  it('still requires schema for every reported eligible job', () => {
    const result = validate('reported', null);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('jobposting_missing');
  });
  it('accepts complete reported schema and counts eligible locales', () => {
    const result = validate('reported', posting);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Eligible locale checks: 4');
  });
  it('rejects a substituted publication date', () => {
    const result = validate('reported', { ...posting, datePosted: '2026-01-02' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('datePosted:reported_mismatch');
  });
  it('accepts a posting whose optional fields are absent because the source lacks them', () => {
    const { validThrough: _v, baseSalary: _b, employmentType: _e, ...bare } = posting;
    const result = validate('reported', { ...bare, jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI' } } }, {
      job: { salaryMin: 61000, salaryMax: 77000, salarySource: 'estimated' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it.each([
    ['an estimated salary in baseSalary', { ...SOURCE_FIELDS, salarySource: 'estimated' }, 'baseSalary:estimate_in_markup'],
    ['a validThrough the source does not state', { ...SOURCE_FIELDS, validThrough: undefined }, 'validThrough:not_from_source'],
    ['a street the source does not state (city-hall default)', { ...SOURCE_FIELDS, streetAddress: undefined }, 'streetAddress:not_from_source'],
    ['an employmentType the source does not state', { ...SOURCE_FIELDS, employmentType: undefined }, 'employmentType:not_from_source'],
  ])('rejects %s', (_label, job, issue) => {
    const result = validate('reported', posting, { job });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(issue);
  });
  it('rejects a reported salary dropped from the markup', () => {
    const result = validate('reported', { ...posting, baseSalary: undefined });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('baseSalary:reported_salary_dropped');
  });

 it('rejects coherent source address values dropped from the markup', () => {
  const schemaWithoutStreetOrPostal = {
   ...posting,
   jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI' } },
  };
  const result = validate('reported', schemaWithoutStreetOrPostal, {
   job: { ...SOURCE_FIELDS, streetAddress: 'Via Nassa 1', postalCode: '6900' },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('streetAddress:source_value_dropped');
  expect(result.stdout).toContain('postalCode:source_value_dropped');
 });
});
