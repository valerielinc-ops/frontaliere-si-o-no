import { describe, expect, it, vi } from 'vitest';
import {
  buildLastminuteSlug,
  extractLastminuteLocationFromContent,
  fetchLastminuteJobDetailUrls,
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
      addressLocality: 'Chiasso',
      postalCode: '6830',
      streetAddress: 'Chiasso',
      addressCountry: 'CH',
    });
  });

  it('fails closed when the listing parser returns zero detail URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>challenge</body></html>', { status: 200 }),
    );

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing returned no detail URLs',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when a later listing page returns zero detail URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('page=1')) {
        return new Response(
          '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>',
          { status: 200 },
        );
      }
      return new Response('<html><body>challenge</body></html>', { status: 200 });
    });

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing returned no detail URLs on page 2',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when a later listing page cannot be fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('page=1')) {
        return new Response(
          '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>',
          { status: 200 },
        );
      }
      throw new Error('connection reset');
    });

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing pagination failed on page 2',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
