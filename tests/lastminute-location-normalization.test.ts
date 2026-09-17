import { describe, expect, it } from 'vitest';
import {
  buildLastminuteSlug,
  extractLastminuteLocationFromContent,
  inferLastminuteLocation,
  normalizeLastminuteRow,
} from '@/scripts/update-lastminute-jobs.mjs';

describe('lastminute location normalization', () => {
  it('extracts Chiasso from the vacancy body instead of the corporate footer address', () => {
    const description = `
      The job in brief:
      - Working model - hybrid from Chiasso
      - Location - Chiasso, Switzerland
      © lastminute.com NV Rokin 92 - 96 1012 KZ Amsterdam, Netherlands
    `;

    expect(extractLastminuteLocationFromContent(description)).toBe('Chiasso');
  });

  it('falls back to the content location when the persisted location is the Amsterdam footer', () => {
    const location = inferLastminuteLocation({
      location: '1012 KZ Amsterdam',
      description:
        'Department: Technology Location: Chiasso, Switzerland Contract: Full-time Main Language: English',
    });

    expect(location).toBe('Chiasso');
    expect(buildLastminuteSlug('Software Engineer – ETLs & Microservices', location)).toBe(
      'software-engineer-etls-microservices-chiasso'
    );
  });

  it('keeps structured address fields present without restoring a city default', () => {
    const normalized = normalizeLastminuteRow({
      title: 'Software Engineer',
      companyKey: 'lastminute-com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000001',
      location: 'Chiasso',
      country: 'CH',
      description: 'A sufficiently detailed job description for a Swiss software role.',
      titleByLocale: { en: 'Software Engineer' },
      descriptionByLocale: { en: 'A sufficiently detailed job description for a Swiss software role.' },
    });

    expect(normalized).toMatchObject({
      location: 'Chiasso',
      canton: 'TI',
      addressLocality: 'Bellinzona',
      postalCode: '6500',
      streetAddress: 'Bellinzona',
      addressCountry: 'CH',
    });
  });
});
