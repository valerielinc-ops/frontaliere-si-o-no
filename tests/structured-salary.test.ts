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
    expect(hardened.updated).toBe(1);
    expect(hardened.changed).toBe(true);
    expect(hardened.jobs[0].baseSalary?.value?.minValue).toBeGreaterThan(0);
    expect(hardened.jobs[1].baseSalary?.value?.minValue).toBe(90000);
  });
});
