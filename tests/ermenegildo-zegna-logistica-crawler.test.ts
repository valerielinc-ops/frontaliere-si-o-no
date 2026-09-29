/**
 * Ermenegildo Zegna Group (careers.zegnagroup.com) — no invented descriptions.
 *
 * A detail page without a vacancy body used to publish the stub
 * "Posizione aperta presso Ermenegildo Zegna Group. Ruolo: X. Sede: Y,
 * Svizzera." (15 words). Now the job keeps its stored body, and a brand-new
 * job without one is not published (#5253).
 */
import { describe, expect, it } from 'vitest';

import {
  mergeZegnaJobLists,
  parseJobDetail,
  zegnaVacancyBody,
} from '@/scripts/update-zegna-jobs.mjs';

// Live shape of job-details?JobID=275981362 (minimised): the vacancy body is
// the JobPosting JSON-LD description.
const BODY =
  'ABOUT ERMENEGILDO ZEGNA GROUP Founded in 1910 in Trivero, Italy, the Ermenegildo Zegna Group is a global luxury company ' +
  'with a leading position in the high-end menswear business. YOUR MISSION IN THIS ROLE As Finance Master Data Specialist, ' +
  'based in Stabio, you will create, maintain and govern Business Partner master data across the Group, validate requests ' +
  'for completeness, accuracy and compliance, and support the definition of standard procedures, controls and governance ' +
  'rules. WHO YOU ARE You bring 3-5 years of relevant professional experience in a Shared Services Center or Finance Operations.';

const DETAIL_HTML = `
<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Finance Master Data Specialist – Business Partner',
  description: BODY,
  jobLocation: { address: { addressCountry: 'Switzerland', addressRegion: 'Ticino', addressLocality: 'Stabio' } },
})}</script></head><body><h1>Finance Master Data Specialist – Business Partner</h1></body></html>`;

const URL_A = 'https://careers.zegnagroup.com/jobs/job-details?JobID=275981362&Team=231361275';
const URL_B = 'https://careers.zegnagroup.com/jobs/job-details?JobID=999999999&Team=231361275';

function discovered(url: string, description: string) {
  return {
    url,
    title: 'Finance Master Data Specialist – Business Partner',
    location: 'Stabio',
    canton: 'TI',
    description,
    descriptionByLocale: description ? { en: description } : {},
    titleByLocale: { en: 'Finance Master Data Specialist – Business Partner' },
    slugByLocale: { en: 'finance-master-data-specialist-business-partner-zegna' },
    sourceLang: description ? 'en' : '',
  };
}

describe('zegnaVacancyBody', () => {
  it('returns the JSON-LD vacancy body read from the detail page', () => {
    const detail = parseJobDetail(DETAIL_HTML, URL_A);
    expect(detail.city).toBe('Stabio');
    expect(zegnaVacancyBody(detail)).toContain('YOUR MISSION IN THIS ROLE');
  });

  it('treats a missing or stub-length body as no body', () => {
    expect(zegnaVacancyBody({ description: '' })).toBe('');
    expect(zegnaVacancyBody({ description: 'Store Style Advisor at Zegna Zurich Airport.' })).toBe('');
  });
});

describe('mergeZegnaJobLists', () => {
  it('keeps the stored body when the fresh detail page has none', () => {
    const stored = { ...discovered(URL_A, BODY), descriptionByLocale: { en: BODY, it: 'Descrizione tradotta del ruolo.' } };
    const { merged, updated, skipped } = mergeZegnaJobLists([stored], [discovered(URL_A, '')]);
    expect(updated).toBe(1);
    expect(skipped).toBe(0);
    expect(merged[0].description).toBe(BODY);
    expect(merged[0].descriptionByLocale.en).toBe(BODY);
    expect(merged[0].sourceLang).toBe('en');
    expect(merged[0].description).not.toMatch(/Posizione aperta presso/);
  });

  it('does not publish a new job whose detail page has no body', () => {
    const { merged, added, skipped } = mergeZegnaJobLists([], [discovered(URL_B, '')]);
    expect(merged).toHaveLength(0);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  it('publishes a new job with its source body', () => {
    const { merged, added } = mergeZegnaJobLists([], [discovered(URL_B, BODY)]);
    expect(added).toBe(1);
    expect(merged[0].description).toBe(BODY);
  });
});

describe('Zegna — review criteria (#10348)', () => {
  it('keeps the stored body, locale slots and language when the same JobID comes back without a body', () => {
    const existing = {
      ...discovered(URL_A, 'source body'),
      descriptionByLocale: { en: 'source body', it: 'corpo tradotto' },
      sourceLang: 'en',
    };
    const { merged } = mergeZegnaJobLists([existing], [{ ...discovered(URL_A, ''), sourceLang: 'it' }]);
    expect(merged[0].description).toBe('source body');
    expect(merged[0].descriptionByLocale).toEqual({ en: 'source body', it: 'corpo tradotto' });
    expect(merged[0].sourceLang).toBe('en');
  });

  it('lets a fresh source body replace the stored one even when it is shorter', () => {
    const fresh = BODY.split(' ').slice(0, 60).join(' ');
    const existing = { ...discovered(URL_A, `${BODY} ${BODY}`), sourceLang: 'en' };
    const { merged } = mergeZegnaJobLists([existing], [discovered(URL_A, fresh)]);
    expect(merged[0].description).toBe(fresh);
    expect(merged[0].descriptionByLocale.en).toBe(fresh);
  });

  it('rejects a 49-word body however many characters it has', () => {
    const long49 = Array.from({ length: 49 }, () => 'Verantwortungsbewusstsein').join(' ');
    expect(long49.length).toBeGreaterThan(1000);
    expect(zegnaVacancyBody({ description: long49 })).toBe('');
    expect(zegnaVacancyBody({ description: `${long49} Stabio` })).not.toBe('');
  });
});
