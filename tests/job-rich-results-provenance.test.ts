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
function validate(source: string | undefined, schema: Record<string, unknown> | null) {
  const root = mkdtempSync(join(tmpdir(), 'rich-result-provenance-'));
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/jobs.json'), JSON.stringify([{ slug: 'example', postingDateSource: source, postedDate: date }]));
    for (const [locale, section] of Object.entries(SECTION_LEGACY_TI)) {
      const dir = join(root, 'dist', locale === 'it' ? '' : locale, section, 'example');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), `<h1>Infermiere</h1>${schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : ''}`);
    }
    return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('rich-result eligibility validation', () => {
  it.each(['unknown'])('requires schema absence for %s provenance', (source) => {
    const result = validate(source, null);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Publication date unverified (JobPosting must be absent): 4');
  });
  it('requires missing legacy provenance to remain ineligible', () => {
    expect(validate(undefined, posting).status).toBe(1);
    expect(validate(undefined, null).status).toBe(0);
  });
  it('rejects schema manufactured for unverified publication', () => {
    const result = validate('unknown', posting);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('jobposting_without_reported_publication_date');
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
    expect(result.stdout).toContain('datePosted:source_mismatch');
  });
  it('preserves mandatory salary validation for eligible jobs', () => {
    const result = validate('reported', { ...posting, baseSalary: undefined });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing_or_invalid:baseSalary');
  });
});
