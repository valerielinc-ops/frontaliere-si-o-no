import { describe, expect, it } from 'vitest';
import {
  DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS,
  DIRECT_EMPLOYER_SOURCE_KEY,
  buildDirectEmployerJob,
  normalizeDirectEmployerSubmission,
} from '../functions/src/directEmployerCore.js';
import { directEmployerSubmissionToRecords } from '../scripts/lib/directEmployerJobProjection.mjs';
import { projectPermanentEmployerFeed } from '../scripts/lib/permanentEmployerProjection.mjs';

function daysFrom(reference: Date, days: number): Date {
  return new Date(reference.getTime() + days * 24 * 60 * 60 * 1000);
}

function description(wordCount = DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS): string {
  return Array.from({ length: wordCount }, (_, index) => `informazione-${index + 1}`).join(' ');
}

function submission(over: Record<string, unknown> = {}) {
  return {
    id: 'submission-direct-1',
    status: 'approved',
    companyName: 'Salumeria del Borgo SA',
    companyWebsite: 'https://salumeria.example.ch',
    title: 'Addetto banco gastronomia',
    locationLabel: 'Mendrisio',
    streetAddress: 'Via del Borgo 4',
    postalCode: '6850',
    canton: 'TI',
    employmentType: 'FULL_TIME',
    description: description(),
    approvedAt: daysFrom(new Date(), -1),
    expiresAt: daysFrom(new Date(), 29),
    ...over,
  };
}

describe('direct employer submission validation', () => {
  it('accepts a named employer and rejects a thin or risky submission', () => {
    const valid = normalizeDirectEmployerSubmission({
      companyName: 'Salumeria del Borgo SA',
      companyWebsite: 'https://salumeria.example.ch',
      title: 'Addetto banco gastronomia',
      locationLabel: 'Mendrisio',
      employmentType: 'FULL_TIME',
      description: description(),
      contactEmail: 'datore@example.ch',
    });
    expect(valid.ok).toBe(true);
    expect(valid.input.descriptionWordCount).toBe(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS);

    const thin = normalizeDirectEmployerSubmission({ ...valid.input, description: description(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS - 1) });
    expect(thin.ok).toBe(false);
    expect(thin.errors).toContain('description_too_short');

    const risky = normalizeDirectEmployerSubmission({ ...valid.input, companyName: 'Anonimo', description: `${description()} lavoro multilevel` });
    expect(risky.ok).toBe(false);
    expect(risky.errors).toEqual(expect.arrayContaining(['company_not_identifiable', 'prohibited_recruitment_copy']));
  });

  it('keeps a honeypot submission out of moderation', () => {
    const result = normalizeDirectEmployerSubmission({
      companyName: 'Officina del Lago',
      title: 'Meccanico',
      locationLabel: 'Chiasso',
      employmentType: 'FULL_TIME',
      description: description(),
      contactEmail: 'datore@example.ch',
      websiteConfirm: 'https://bot.example',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('honeypot');
  });
});

describe('direct employer job projection', () => {
  it('emits the mandatory structured-data source fields and no contact data', () => {
    const now = new Date();
    const [record] = directEmployerSubmissionToRecords(submission(), { now });
    expect(record.source).toBe(DIRECT_EMPLOYER_SOURCE_KEY);
    expect(record.description.split(/\s+/u)).toHaveLength(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS);
    expect(record.datePosted).toBeTruthy();
    expect(record.validThrough).toBeTruthy();
    expect(record.company).toBeTruthy();
    expect(record.location).toBeTruthy();
    expect(record.employmentType).toBe('FULL_TIME');
    expect(record.applyUrl).toMatch(/\/\?job=/u);
    expect(record).not.toHaveProperty('contactEmail');
    expect(record).not.toHaveProperty('contactPhone');
  });

  it('excludes expired and thin approved submissions from the index', () => {
    const now = new Date();
    expect(directEmployerSubmissionToRecords(submission({ expiresAt: daysFrom(now, -1) }), { now })).toEqual([]);
    expect(directEmployerSubmissionToRecords(submission({ description: description(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS - 1) }), { now })).toEqual([]);
  });

  it('fills safe address and salary defaults for structured data consumers', () => {
    const job = buildDirectEmployerJob(submission({ streetAddress: '', postalCode: '', salaryMin: null, salaryMax: null }), new Date());
    expect(job.addressRegion).toBe('TI');
    expect(job.addressCountry).toBe('CH');
    expect(job.currency).toBe('CHF');
    expect(job.employmentType).toBeTruthy();
  });
});

describe('prospector permanent-employer projection', () => {
  it('publishes only explicit permanent signals and strips operational fields', () => {
    const feed = projectPermanentEmployerFeed({
      updatedAt: daysFrom(new Date(), -1).toISOString(),
      candidates: {
        'salumeria.example': {
          name: 'Salumeria del Borgo SA',
          domain: 'salumeria.example',
          careersUrl: 'https://salumeria.example/candidature/',
          city: 'Mendrisio',
          permanentApplicationOnly: true,
          email: 'must-not-leak@example.test',
        },
        'ordinary.example': {
          name: 'Ordinary Employer SA',
          domain: 'ordinary.example',
          careersUrl: 'https://ordinary.example/jobs/',
          permanentApplications: [],
        },
        'insecure.example': {
          name: 'Insecure Employer SA',
          domain: '',
          careersUrl: 'http://insecure.example/',
          permanentApplications: [{ label: 'Candidatura spontanea' }],
        },
      },
    });

    expect(feed.employers).toHaveLength(1);
    expect(feed.employers[0]).toMatchObject({
      companyName: 'Salumeria del Borgo SA',
      website: 'https://salumeria.example/candidature/',
      locationLabel: 'Mendrisio',
    });
    expect(feed.employers[0]).not.toHaveProperty('email');
    expect(JSON.stringify(feed)).not.toContain('must-not-leak');
  });
});
