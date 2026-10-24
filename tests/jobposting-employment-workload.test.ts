import { describe, expect, it } from 'vitest';
import { buildJobPostingFacts } from '../build-plugins/shared/jobPostingSchema';
import { isPartTimeWorkload, workloadPercent } from '../scripts/lib/employment-workload.mjs';
import { normalizeContract } from '../scripts/lib/dedicated-crawler-common.mjs';
import { normalizeJobContract } from '../services/jobDataNormalization';

const job = (patch: Record<string, unknown>) => ({
  id: 'x-1',
  title: 'Pflegefachperson HF',
  company: 'Acme AG',
  location: 'Bern',
  canton: 'BE',
  ...patch,
});

const typeOf = (patch: Record<string, unknown>) => buildJobPostingFacts(job(patch) as any, 'de').employmentType;

describe('JobPosting employmentType', () => {
  it('reads a part-time workload from the title when the crawler wrote OTHER', () => {
    // The scaffolded parsers write OTHER for every percentage title.
    expect(typeOf({ title: 'Night Watch 20-40 %', employmentType: 'OTHER', contract: 'other' })).toBe('PART_TIME');
    expect(typeOf({ title: 'Verkäufer/in 60%', employmentType: 'OTHER' })).toBe('PART_TIME');
  });

  it('keeps FULL_TIME for a full workload or no workload at all', () => {
    expect(typeOf({ title: 'Projektleiter 80-100%', employmentType: 'OTHER' })).toBe('FULL_TIME');
    expect(typeOf({ title: 'Projektleiter', employmentType: 'OTHER' })).toBe('FULL_TIME');
    expect(typeOf({ title: 'Projektleiter' })).toBe('FULL_TIME');
  });

  it('lets a known contract field win over the title and over an unknown field', () => {
    expect(typeOf({ title: 'Assistent 50%', employmentType: 'FULL_TIME' })).toBe('FULL_TIME');
    expect(typeOf({ title: 'Lernende/r', employmentType: 'OTHER', contractType: 'apprenticeship' })).toBe('INTERN');
  });
});

describe('normalizeJobContract workload', () => {
  it('classifies a workload range by its upper bound and prefers the title', () => {
    expect(normalizeJobContract('', 'Pflegefachperson 70% - 100%', '')).not.toBe('part-time');
    expect(normalizeJobContract('', 'Verkäufer/in 60%', '100% Lohnfortzahlung')).toBe('part-time');
    expect(normalizeJobContract('', 'Koch 100%', 'Teamevents zu 50% bezahlt')).not.toBe('part-time');
  });
});

describe('employment-workload', () => {
  it('is the rule the crawlers already apply', () => {
    for (const title of ['Verkäufer 60%', 'Pflege 70% - 100%', 'Koch 100%', 'Koch']) {
      expect(isPartTimeWorkload(title)).toBe(normalizeContract('', title, '') === 'part-time');
    }
    expect(workloadPercent('Pflege 70% - 100%')).toBe(100);
    expect(Number.isNaN(workloadPercent('Koch'))).toBe(true);
  });

  it('does not treat a qualifier percentage as employment workload', () => {
    expect(isPartTimeWorkload('Sales Manager 50% travel')).toBe(false);
    expect(isPartTimeWorkload('Night Watch 20-40 %')).toBe(true);
  });
});
