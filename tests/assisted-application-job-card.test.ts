import { describe, expect, it } from 'vitest';
import { enrichAssistedApplicationOrder } from '../functions/src/assistedApplicationJobCard.js';
import { buildConciergeNewJobsEmail } from '../functions/src/applicationConciergeLifecycleEmails.js';
import { buildCustomerEmail } from '../functions/src/assistedApplicationNotifications.js';
import { buildAlertEmail } from '../scripts/send-job-alerts.mjs';

function cardMarkup(html: string) {
  return html.match(/<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#1e293b;border-radius:12px;">[\s\S]*?<\/table>/)?.[0] || '';
}

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

  it('uses the exact Job Alert card markup in concierge proposal and submitted emails', () => {
    const title = 'Application Manager';
    const company = 'Stadt Zürich';
    const location = 'Zürich';
    const companyLogo = 'https://cdn.frontaliereticino.ch/images/brands/stadt-zuerich.png';
    const alert = buildAlertEmail({
      id: 'card-parity', email: 'card@example.test', locale: 'it', keywords: [], locations: [], sectors: [],
    }, [{
      title, company, companyKey: 'stadt-zuerich', location,
      slug: 'application-manager-stadt-zurich', slugByLocale: {}, titleByLocale: {},
    }], false);
    const proposals = buildConciergeNewJobsEmail({ locale: 'it' }, 'service-card-parity', [{
      jobTitle: title, companyName: company, location, companyLogo, jobUrl: 'https://jobs.example.test/application-manager',
    }]);
    const submitted = buildCustomerEmail('submitted', {
      locale: 'it', jobTitle: title, companyName: company, location, companyLogo,
      jobUrl: 'https://jobs.example.test/application-manager',
    }, 'order-card-parity');

    const alertCard = cardMarkup(alert.html);
    expect(alertCard).not.toBe('');
    expect(cardMarkup(proposals.html)).toBe(alertCard);
    expect(cardMarkup(submitted.html)).toBe(alertCard);
  });

  it('derives a safe CDN-logo key from a matching company display name', async () => {
    const enriched = await enrichAssistedApplicationOrder({
      jobId: 'stadt-zuerich-job',
      companyId: 'Stadt Zürich',
      companyName: 'Stadt Zürich',
      jobTitle: 'Application Manager',
      jobUrl: 'https://jobs.example.test/application-manager',
    }, {
      fetchImpl: async (url, init = {}) => {
        if (String(init.method || '').toUpperCase() === 'HEAD') {
          return { ok: url.endsWith('/images/brands/stadt-zuerich.png') } as Response;
        }
        return { ok: true, async json() { return {}; } } as Response;
      },
    });

    expect(enriched.companyLogo).toBe('https://cdn.frontaliereticino.ch/images/brands/stadt-zuerich.png');
  });
});
