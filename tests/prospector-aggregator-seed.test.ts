import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';

function postingPage(origin: string) {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Pflegefachperson HF 80-100%',
    description: 'Wir suchen eine Pflegefachperson für unser Team in Bern. Ihre Aufgaben umfassen die Betreuung und Pflege.',
    datePosted: new Date().toISOString().slice(0, 10),
    url: `${origin}/view?id=554547064889945322`,
    hiringOrganization: { '@type': 'Organization', name: 'Global Sana' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Bern', postalCode: '3011', addressCountry: 'CH' } },
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><h1>${posting.title}</h1></body></html>`;
}

describe('SYNTHESIZE on a job search engine page', () => {
  beforeEach(() => politeFetch.mockReset());

  it('refuses a seed on a known aggregator even when it names one employer', async () => {
    const url = 'https://ch.talent.com/view?id=554547064889945322';
    politeFetch.mockResolvedValue({ ok: true, status: 200, url, body: postingPage('https://ch.talent.com') });

    const result = await synthesizeSpec({
      careersUrl: url,
      tenantHost: 'ch.talent.com',
      domain: 'globalsana.ch',
      name: 'Global Sana',
    });
    expect(result.spec).toBeNull();
    expect(result).toMatchObject({ reasonCode: 'aggregator_seed' });
    expect(result.retryable).toBeFalsy();
  });
});
