import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractPromanFleurierDetailFields,
  isPromanFleurierExpectedDetailFilter,
  isPromanFleurierJob,
  isTrustedDomain,
  PROMAN_FLEURIER_KEY,
} from '../scripts/lib/proman-fleurier-job-parser.mjs';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

const detailUrl = 'https://www.proman-group.ch/job/25097/Automaticien-HF/';
const detailFixture = readFileSync(
  new URL('./fixtures/proman-fleurier-detail.html', import.meta.url),
  'utf8',
);

describe('PROMAN Fleurier source-backed crawler', () => {
  it('extracts the official JobPosting location and keeps a substantial description', () => {
    const detail = extractPromanFleurierDetailFields(detailFixture, detailUrl);
    expect(detail.title).toBe('Automaticien de production');
    expect(detail.location).toContain('Fleurier');
    expect(detail.canton).toBe('NE');
    expect(detail.addressLocality).toBe('Fleurier');
    expect(detail.description.split(/\s+/u).length).toBeGreaterThan(50);
  });

  it('classifies a source-backed non-NE detail as an expected canton filter', () => {
    const nonTargetFixture = detailFixture
      .replaceAll('Fleurier', 'Biel')
      .replaceAll('2114', '2500')
      .replaceAll('"NE"', '"BE"');
    const detail = extractPromanFleurierDetailFields(nonTargetFixture, detailUrl);
    expect(detail.location).toBe('');
    expect(detail.sourceBackedCanton).toBe('BE');
    expect(isPromanFleurierExpectedDetailFilter({ reason: 'geography', detail })).toBe(true);
    expect(isPromanFleurierExpectedDetailFilter({ reason: 'geography', detail: {} })).toBe(false);
  });

  it('keeps the promoted spec and detail URL contract aligned with the official board', () => {
    const spec = loadSpec(PROMAN_FLEURIER_KEY);
    expect(spec.companyHost).toBe('proman-group.ch');
    expect(spec.canton).toBe('NE');
    expect(spec.seedUrls[0]).toContain('proman-group.ch/Job/SearchJobs/');
    expect(spec.sampleTitles).toContain('Automaticien de production');
    expect(templateToRegex(spec.detailTemplate).test('/job/25097/Automaticien-HF')).toBe(true);
  });

  it('matches only the dedicated company key and official Proman hosts', () => {
    expect(isPromanFleurierJob({ companyKey: PROMAN_FLEURIER_KEY })).toBe(true);
    expect(isPromanFleurierJob({ companyKey: 'proman-other' })).toBe(false);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
  });
});
