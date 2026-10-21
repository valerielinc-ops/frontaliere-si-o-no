import { describe, expect, it } from 'vitest';
import { enrichAssistedApplicationOrder } from '../functions/src/assistedApplicationJobCard.js';

describe('assisted application email card metadata', () => {
  it('fills legacy pending orders from the public job detail and CDN logo', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (method === 'HEAD') {
        return { ok: url.endsWith('/images/brands/acme-sa.svg') } as Response;
      }
      return {
        ok: true,
        async json() {
          return {
            addressLocality: 'Lugano',
            addressRegion: 'TI',
            employmentType: 'FULL_TIME',
            baseSalary: {
              currency: 'CHF',
              value: { minValue: 75000, maxValue: 90000, unitText: 'YEAR' },
            },
            firstSeenAt: '2026-10-02T10:00:00.000Z',
            postedDate: '2026-10-01',
            sector: 'Tecnologia',
          };
        },
      } as Response;
    };

    const enriched = await enrichAssistedApplicationOrder({
      orderId: 'pending-legacy',
      jobId: 'acme-job-1',
      companyId: 'acme-sa',
      companyName: 'ACME SA',
      jobTitle: 'Software Developer',
      jobUrl: 'https://jobs.example.test/acme-job-1',
    }, { fetchImpl });

    expect(enriched).toMatchObject({
      companyLogo: 'https://cdn.frontaliereticino.ch/images/brands/acme-sa.svg',
      companyKey: 'acme-sa',
      location: 'Lugano',
      canton: 'TI',
      contract: 'FULL_TIME',
      salaryMin: 75000,
      salaryMax: 90000,
      salaryCurrency: 'CHF',
      firstSeenAt: '2026-10-02T10:00:00.000Z',
      postedDate: '2026-10-01',
      sector: 'Tecnologia',
    });
    expect(enriched.baseSalary).toEqual({
      currency: 'CHF',
      value: { minValue: 75000, maxValue: 90000, unitText: 'YEAR' },
    });
    expect(calls.some(({ method }) => method === 'HEAD')).toBe(true);
    expect(calls.some(({ method, url }) => method === 'GET' && url.endsWith('/data/job-detail/acme-job-1.json'))).toBe(true);
  });

  it('does not resolve a logo from an unsafe company key', async () => {
    let calls = 0;
    const enriched = await enrichAssistedApplicationOrder({
      jobId: 'legacy-job',
      companyId: '../private',
      companyName: 'ACME SA',
      jobTitle: 'Software Developer',
    }, { fetchImpl: async () => { calls += 1; return { ok: false } as Response; } });

    expect(enriched.companyLogo).toBeUndefined();
    expect(calls).toBe(1); // only the bounded public job-detail lookup is attempted
  });

  it('replaces a legacy non-HTTPS logo with the stable CDN logo', async () => {
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      if (String(init.method || '').toUpperCase() === 'HEAD') {
        return { ok: url.endsWith('/images/brands/acme-sa.svg') } as Response;
      }
      return { ok: true, async json() { return {}; } } as Response;
    };

    const enriched = await enrichAssistedApplicationOrder({
      jobId: 'legacy-job',
      companyId: 'acme-sa',
      companyLogo: 'http://old.example.test/acme.png',
    }, { fetchImpl });

    expect(enriched.companyLogo).toBe('https://cdn.frontaliereticino.ch/images/brands/acme-sa.svg');
  });
});
