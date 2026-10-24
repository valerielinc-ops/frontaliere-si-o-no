/**
 * Owner decision 2026-10-24: the JobPosting is always emitted and each field
 * is present if and only if the source states it. These are the shared
 * predicates the builder and the rich-results observer agree on.
 */
import { describe, expect, it } from 'vitest';
import {
  employmentTypeJsonLdValue,
  formatJobEmploymentTypes,
  resolveJobEmploymentTypes,
} from '../../scripts/lib/job-employment-type.mjs';
import { isSalaryReportedBySource, isSourceStreetAddress } from '../../scripts/lib/jobposting-field-provenance.mjs';
import { renderMobileActionBlock } from '../../build-plugins/shared/jobDetailHtml/mobileActionBlock';
import { formatActiveJobSalaryText } from '../../build-plugins/jobsSeoPagesPlugin';

describe('resolveJobEmploymentTypes', () => {
  it.each([
    [{ employmentType: 'FULL_TIME' }, ['FULL_TIME']],
    [{ employmentType: 'full-time', contractType: 'temporary' }, ['FULL_TIME', 'TEMPORARY']],
    [{ contract: 'fixed-term' }, ['TEMPORARY']],
    [{ contractType: 'intern (fixed term) (trainee)' }, ['TEMPORARY', 'INTERN']],
    [{ contractType: 'fixed term contract (fixed term)' }, ['TEMPORARY']],
    [{ contract: 'contract' }, ['CONTRACTOR']],
    [{ contract: 'other' }, []],
    [{ employmentType: 'OTHER' }, []],
    [{ contract: 'other', employmentType: 'PART_TIME' }, ['PART_TIME']],
    [{ contract: 'indeterminato' }, []],
    [{ contract: 'permanent' }, []],
    [{ contractType: 'regular' }, []],
    [{}, []],
  ])('%o -> %o', (job, expected) => {
    expect(resolveJobEmploymentTypes(job)).toEqual(expected);
  });

  it('falls back to the workload the title states (#15009)', () => {
    expect(resolveJobEmploymentTypes({ employmentType: 'OTHER' }, 'Verkäufer/in 60%')).toEqual(['PART_TIME']);
    expect(resolveJobEmploymentTypes({ employmentType: 'OTHER' }, 'Projektleiter 80-100%')).toEqual(['FULL_TIME']);
    expect(resolveJobEmploymentTypes({ employmentType: 'FULL_TIME' }, 'Assistent 50%')).toEqual(['FULL_TIME']);
    expect(resolveJobEmploymentTypes({}, 'Sales Manager 50% travel')).toEqual([]);
  });

  it('shapes the JSON-LD value as absent, one token or an array', () => {
    expect(employmentTypeJsonLdValue([])).toBeUndefined();
    expect(employmentTypeJsonLdValue(['FULL_TIME'])).toBe('FULL_TIME');
    expect(employmentTypeJsonLdValue(['FULL_TIME', 'TEMPORARY'])).toEqual(['FULL_TIME', 'TEMPORARY']);
  });

  it('labels the same resolution for the page, never the raw "other"', () => {
    expect(formatJobEmploymentTypes(['FULL_TIME', 'TEMPORARY'], 'it')).toBe('Tempo pieno, Temporaneo');
    expect(formatJobEmploymentTypes([], 'it')).toBe('non indicato');
    expect(formatJobEmploymentTypes([], 'de')).toBe('nicht angegeben');
  });
});

describe('field provenance predicates', () => {
  it('only a reported salary is the source salary', () => {
    expect(isSalaryReportedBySource({ salarySource: 'reported' })).toBe(true);
    for (const salarySource of ['estimated', 'existing', undefined, '']) {
      expect(isSalaryReportedBySource({ salarySource })).toBe(false);
    }
  });

  it('a street is a street of the locality, not the locality itself', () => {
    expect(isSourceStreetAddress('Via Nassa 5', 'Lugano')).toBe(true);
    expect(isSourceStreetAddress('Bahnhofstrasse', 'Zürich')).toBe(true);
    expect(isSourceStreetAddress('Lugano', 'Lugano')).toBe(false);
    expect(isSourceStreetAddress('Lugano, Ticino', 'Lugano')).toBe(false);
    expect(isSourceStreetAddress('2026', 'Lugano')).toBe(false);
  });
});

describe('visible page: same contract and labelled salary estimate', () => {
  it('the mobile block prints the resolved contract, not "other"', () => {
    const html = renderMobileActionBlock({
      job: { slug: 'macchinista', employmentType: 'full-time', contractType: 'temporary' },
      locale: 'it',
      canonicalUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/macchinista/',
      addressLocality: 'Lugano',
      salaryMin: Number.NaN,
      salaryText: '',
      localeLabels: { applyNow: 'Vai', quickDetails: 'Dettagli', location: 'Località', contract: 'Contratto' },
      referralUrl: () => '#',
      esc: (s: string) => s,
    });
    expect(html).toContain('<dd>Tempo pieno, Temporaneo</dd>');
    expect(html).not.toContain('<dd>other</dd>');
  });

  it('an estimated salary carries the "(stima)" label, a reported one none', () => {
    expect(formatActiveJobSalaryText('it', 61000, 77000, 'CHF', 'estimated')).toMatch(/\(stima\)$/);
    expect(formatActiveJobSalaryText('it', 61000, 77000, 'CHF', 'reported')).not.toMatch(/\(/);
  });
});
