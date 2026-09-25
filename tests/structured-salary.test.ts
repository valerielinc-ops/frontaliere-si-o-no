import { describe, expect, it } from 'vitest';

import { ensureStructuredSalary, hardenJobsWithStructuredSalary } from '../scripts/lib/structured-salary.mjs';

describe('structured salary hardening', () => {
  it('estimates a yearly baseSalary when a job has no salary fields', () => {
    const result = ensureStructuredSalary({
      title: 'Tecnico di servizio Fossile Regione Ticino (m/f/div.) REF280202G',
      company: 'Bosch Thermotechnik AG',
      category: 'sales',
      employmentType: 'full-time',
      location: 'Rivera',
    });

    expect(result.changed).toBe(true);
    expect(result.job.salaryMin).toBeGreaterThan(0);
    expect(result.job.salaryMax).toBeGreaterThan(result.job.salaryMin);
    expect(result.job.baseSalary?.currency).toBe('CHF');
    expect(result.job.baseSalary?.value?.unitText).toBe('YEAR');
    expect(result.job.baseSalary?.value?.minValue).toBe(result.job.salaryMin);
    expect(result.job.baseSalary?.value?.maxValue).toBe(result.job.salaryMax);
  });

  it('preserves existing salary bounds while normalizing baseSalary', () => {
    const result = ensureStructuredSalary({
      title: 'Software Engineer',
      category: 'tech',
      salaryMin: 91000,
      salaryMax: 118000,
      currency: 'chf',
    });

    expect(result.job.salaryMin).toBe(91000);
    expect(result.job.salaryMax).toBe(118000);
    expect(result.job.baseSalary?.currency).toBe('CHF');
    expect(result.job.baseSalary?.value?.minValue).toBe(91000);
    expect(result.job.baseSalary?.value?.maxValue).toBe(118000);
  });

  it('classifies a job with no salary fields as an estimated salarySource', () => {
    const result = ensureStructuredSalary({
      title: 'Tecnico di servizio Fossile Regione Ticino (m/f/div.) REF280202G',
      company: 'Bosch Thermotechnik AG',
      category: 'sales',
      employmentType: 'full-time',
      location: 'Rivera',
    });

    expect(result.job.salarySource).toBe('estimated');
  });

  it('classifies a job with a declared salary as a reported salarySource', () => {
    const result = ensureStructuredSalary({
      title: 'Software Engineer',
      category: 'tech',
      salaryMin: 91000,
      salaryMax: 118000,
      currency: 'CHF',
    });

    expect(result.job.salarySource).toBe('reported');
  });

  it('keeps salarySource as estimated across repeated harden passes on a persisted estimate', () => {
    const first = ensureStructuredSalary({
      title: 'Sales Associate',
      category: 'Commerciale',
      canton: 'ZH',
      employmentType: 'FULL_TIME',
    });
    const second = ensureStructuredSalary(first.job);

    expect(first.job.salarySource).toBe('estimated');
    expect(second.job.salarySource).toBe('estimated');
    expect(second.changed).toBe(false);
  });

  it('reduces an estimated salary to the stated part-time workload', () => {
    const fullTime = ensureStructuredSalary({
      title: 'Sales Associate',
      category: 'Commerciale',
      canton: 'ZH',
      employmentType: 'FULL_TIME',
    });
    const partTime = ensureStructuredSalary({
      title: 'Sales Associate - Part-time (20%)',
      category: 'Commerciale',
      canton: 'ZH',
      contract: 'part-time',
      employmentType: 'PART_TIME',
    });

    // 20% workload → roughly one fifth of the full-time estimate.
    expect(partTime.job.salaryMin).toBe(Math.round((fullTime.job.salaryMin * 0.2) / 100) * 100);
    expect(partTime.job.salaryMax).toBe(Math.round((fullTime.job.salaryMax * 0.2) / 100) * 100);
    expect(partTime.job.salaryMax).toBeGreaterThan(partTime.job.salaryMin);
    expect(partTime.job.baseSalary?.value?.minValue).toBe(partTime.job.salaryMin);
  });

  it('is idempotent: a scaled part-time salary is not reduced again', () => {
    const first = ensureStructuredSalary({
      title: 'Verkaufsmitarbeiter – Teilzeit (20 %)',
      category: 'Commerciale',
      canton: 'ZH',
      contract: 'part-time',
      employmentType: 'PART_TIME',
    });
    const second = ensureStructuredSalary(first.job);

    expect(second.job.salaryMin).toBe(first.job.salaryMin);
    expect(second.job.salaryMax).toBe(first.job.salaryMax);
    expect(second.changed).toBe(false);
  });

  it('keeps a salary reported in the posting even for a part-time role', () => {
    const result = ensureStructuredSalary({
      title: 'Pflegefachperson Teilzeit (60%)',
      category: 'health',
      canton: 'TI',
      contract: 'part-time',
      employmentType: 'PART_TIME',
      salaryMin: 33000,
      salaryMax: 41000,
      currency: 'CHF',
    });

    expect(result.job.salaryMin).toBe(33000);
    expect(result.job.salaryMax).toBe(41000);
  });

  it('reports how many jobs were hardened in a collection', () => {
    const hardened = hardenJobsWithStructuredSalary([
      {
        title: 'Software Engineer',
        category: 'tech',
      },
      {
        title: 'Accountant',
        category: 'finance',
        salaryMin: 90000,
        salaryMax: 110000,
        currency: 'CHF',
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'CHF',
          value: {
            '@type': 'QuantitativeValue',
            minValue: 90000,
            maxValue: 110000,
            unitText: 'YEAR',
          },
        },
      },
    ]);

    expect(hardened.total).toBe(2);
    // Both records change: job 0 gains an estimated band, job 1 keeps its
    // declared bounds but newly gains a 'reported' salarySource.
    expect(hardened.updated).toBe(2);
    expect(hardened.changed).toBe(true);
    expect(hardened.jobs[0].baseSalary?.value?.minValue).toBeGreaterThan(0);
    expect(hardened.jobs[0].salarySource).toBe('estimated');
    expect(hardened.jobs[1].baseSalary?.value?.minValue).toBe(90000);
    expect(hardened.jobs[1].salarySource).toBe('reported');
  });
});
