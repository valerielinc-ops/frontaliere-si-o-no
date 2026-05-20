// tests/schemas/job-schema.test.ts
import { describe, it, expect } from 'vitest';
import { JobSchema } from '../../scripts/lib/schemas/job.mjs';

const validJob = {
  id: 'vaudoise-12345',
  stableId: '550e8400-e29b-41d4-a716-446655440000',
  slug: 'sviluppatore-frontend-lausanne',
  url: 'https://vaudoise.ch/jobs/12345',
  title: 'Sviluppatore Frontend',
  company: 'Vaudoise Assurances',
  hiringOrganization: { name: 'Vaudoise Assurances' },
  location: 'Lausanne',
  addressLocality: 'Lausanne',
  postalCode: '1003',
  streetAddress: 'Place de Milan 1',
  description: 'Cerchiamo uno sviluppatore frontend con esperienza in React per la nostra sede di Losanna. Lavorerai in un team di 8 persone.',
  datePosted: '2026-05-15',
  employmentType: 'FULL_TIME',
  jobLocation: {
    addressLocality: 'Lausanne',
    postalCode: '1003',
    addressCountry: 'CH',
  },
  baseSalary: {
    currency: 'CHF',
    value: { minValue: 80000, maxValue: 110000, unitText: 'YEAR' },
  },
};

describe('JobSchema', () => {
  it('accepts a fully-populated job', () => {
    const res = JobSchema.safeParse(validJob);
    if (!res.success) console.error(res.error.issues);
    expect(res.success).toBe(true);
  });

  it('rejects job without baseSalary (CLAUDE.md rule #3)', () => {
    const { baseSalary, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job without postalCode', () => {
    const { postalCode, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job without streetAddress', () => {
    const { streetAddress, ...without } = validJob;
    expect(JobSchema.safeParse(without).success).toBe(false);
  });

  it('rejects job with description < 50 chars (thin content, rule #4)', () => {
    const thin = { ...validJob, description: 'too short' };
    expect(JobSchema.safeParse(thin).success).toBe(false);
  });

  it('rejects job with title > 66 chars', () => {
    const longTitle = { ...validJob, title: 'A'.repeat(67) };
    expect(JobSchema.safeParse(longTitle).success).toBe(false);
  });

  it('rejects malformed postalCode (must be 4 digits)', () => {
    const bad = { ...validJob, postalCode: 'CH-1003' };
    expect(JobSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown employmentType', () => {
    const bad = { ...validJob, employmentType: 'GIG_WORK' };
    expect(JobSchema.safeParse(bad).success).toBe(false);
  });
});
