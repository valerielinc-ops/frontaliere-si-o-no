import { describe, expect, it } from 'vitest';
import {
  CRR_KEY,
  LISTING_URL,
  extractDetailBody,
  fetchAllCrrJobs,
  isCrrJob,
  isTrustedDomain,
  parseCrrDetail,
  parseListing,
} from '../scripts/lib/crr-suva-sion-job-parser.mjs';

const LIVE_CARD_ROWS = [
  ['741c6c83-00fa-4e91-abca-0a10bbed5747', 'Stagiaire MP-E', 'Sion · 100%'],
  ['de80570c-ff91-462e-b258-216042b603e9', 'Apprenti·e Gestionnaire en hôtellerie-intendance CFC', 'Sion · 100%'],
  ['b6915e04-5f4c-4210-8bd7-cb54f4bd06d8', 'Apprenti·e Bottier/ère-orthopédiste CFC', 'Sion · 100%'],
  ['8aa031ab-c8bf-4fef-bdc5-d8e377fd80c6', 'Assistant/e de qualité et de processus', 'Sion · 60%'],
  ['89e5252a-b764-429a-8e51-2e2814d01712', 'Apprenti·e assistant·e en soins et santé communautaire (ASSC) – CFC, voie duale mixte', 'Sion · 100%'],
  ['a89e2ab3-48b1-478c-aa76-241e1891e0e2', 'Infirmier/ère HES – ES', 'Sion · 80%-100%'],
] as const;

function card([id, title, resume]: typeof LIVE_CARD_ROWS[number]) {
  return `<a class="post-link" target="_blank" rel="noopener" href="https://www.jobup.ch/en/jobs/detail/${id}/?utm_source=relationship&#038;utm_medium=referral">
    <div class="page-list-item-card"><div class="post-data">
      <h3 class="post-title post-title-in-data">${title}</h3>
      <div class="post-resume"><span class="post-resume-wrapper">${resume}</span></div>
    </div></div>
  </a>`;
}

const LISTING_HTML = `
  <main>${LIVE_CARD_ROWS.map(card).join('\n')}</main>
  <!-- TYPO3 may render the same card twice; the parser must keep stable identity. -->
  ${card(LIVE_CARD_ROWS[0])}
  <a class="footer-link" href="https://www.jobup.ch/en/jobs/detail/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/">Unrelated footer link</a>
`;

const SOURCE_DESCRIPTION = `
  <p>Take your first professional steps in a cutting-edge clinic, serving people who are relearning to live after an accident.</p>
  <h3>Your internship in brief</h3>
  <ul><li>Duration: 12 months</li><li>Work rate: 100%</li><li>Location: Sion</li></ul>
  <h3>Your tasks</h3>
  <p>You welcome and guide patients and visitors, prepare records and data, handle mail and invoicing, and support the human resources team.</p>
  <h3>Your profile</h3>
  <p>You are curious, reliable, precise and comfortable working both with people and with digital tools in a healthcare environment.</p>
`;

const DETAIL_HTML = `
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList"}</script>
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'MP-E Intern',
    description: SOURCE_DESCRIPTION,
    identifier: { '@type': 'PropertyValue', name: 'Job ID', value: LIVE_CARD_ROWS[0][0] },
    url: `https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/`,
    datePosted: '2026-11-12T10:15:42+01:00',
    hiringOrganization: { '@type': 'Organization', name: 'Clinique romande de réadaptation' },
    employmentType: 'Internship',
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Avenue Grand Champsec 90',
        addressRegion: 'Sion',
        postalCode: '1950',
        addressCountry: 'CH',
      },
    },
  })}</script>
`;

describe('CRR Suva Sion crawler', () => {
  it('targets the current TYPO3 career listing', () => {
    expect(LISTING_URL).toBe('https://www.crr-suva.ch/fr/la-clinique/carriere/offres-d-emploi-1999/');
  });

  it('parses the six current Jobup cards, removes tracking and de-duplicates URLs', () => {
    const rows = parseListing(LISTING_HTML);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      url: `https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/`,
      title: 'Stagiaire MP-E',
      location: 'Sion',
      workload: '100%',
    });
    expect(rows.at(-1)).toMatchObject({
      title: 'Infirmier/ère HES – ES',
      workload: '80%-100%',
    });
  });

  it('accepts a canonical slugged Jobup UUID detail URL from a CRR card', () => {
    const [id, title, resume] = LIVE_CARD_ROWS[0];
    const rows = parseListing(`<a class="post-link" href="https://www.jobup.ch/en/jobs/detail/${id}/stagiaire-mp-e/"><h3 class="post-title">${title}</h3><span class="post-resume">${resume}</span></a>`);
    expect(rows).toEqual([expect.objectContaining({
      url: `https://www.jobup.ch/en/jobs/detail/${id}/stagiaire-mp-e/`, title,
    })]);
  });

  it('ignores arbitrary Jobup links that are not CRR vacancy cards', () => {
    expect(parseListing('<a href="https://www.jobup.ch/en/jobs/detail/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/">Other employer</a>')).toEqual([]);
    expect(parseListing('<a class="post-link" href="https://jobup.ch/en/companies/example/">Company</a>')).toEqual([]);
    expect(parseListing('')).toEqual([]);
  });

  it('allows CRR and Jobup hosts without treating every Jobup vacancy as a CRR job', () => {
    expect(isTrustedDomain(LISTING_URL)).toBe(true);
    expect(isTrustedDomain(`https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/`)).toBe(true);
    expect(isTrustedDomain('https://jobup.ch.evil.example/jobs/detail/foo')).toBe(false);
    expect(isCrrJob({ companyKey: CRR_KEY, url: `https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/` })).toBe(true);
    expect(isCrrJob({ companyKey: 'other-company', url: `https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/` })).toBe(false);
  });

  it('reads source body, publication and Sion address from JobPosting JSON-LD', () => {
    const detail = parseCrrDetail(DETAIL_HTML);

    expect(detail).toMatchObject({
      title: 'MP-E Intern',
      hiringOrganizationName: 'Clinique romande de réadaptation',
      datePosted: '2026-11-12T10:15:42+01:00',
      employmentType: 'Internship',
      addressLocality: 'Sion',
      streetAddress: 'Avenue Grand Champsec 90',
      postalCode: '1950',
      addressCountry: 'CH',
    });
    expect(detail?.body).toContain('Take your first professional steps');
    expect(detail?.body).toContain('• Duration: 12 months');
    expect(extractDetailBody(DETAIL_HTML)).toBe(detail?.body);
  });

  it('normalizes object-form schema.org addressCountry to its name', () => {
    const detail = parseCrrDetail(DETAIL_HTML.replace('"addressCountry":"CH"', '"addressCountry":{"name":"Switzerland"}'));
    expect(detail?.addressCountry).toBe('Switzerland');
  });

  it('fails closed when the detail has no valid JobPosting', () => {
    expect(parseCrrDetail('<h1>Generic Jobup page</h1>')).toBeNull();
    expect(parseCrrDetail('<script type="application/ld+json">{bad json}</script>')).toBeNull();
    expect(parseCrrDetail(`<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Unrelated vacancy',
      description: SOURCE_DESCRIPTION,
      hiringOrganization: { '@type': 'Organization', name: 'Other Employer SA' },
    })}</script>`)).toBeNull();
    expect(extractDetailBody('<h1>Generic Jobup page</h1>')).toBe('');
  });

  it('assembles a job from the CRR listing and source-backed Jobup detail', async () => {
    const listing = card(LIVE_CARD_ROWS[0]);
    const detailUrl = `https://www.jobup.ch/en/jobs/detail/${LIVE_CARD_ROWS[0][0]}/`;
    const requested: string[] = [];
    const jobs = await fetchAllCrrJobs({
      fetchPage: async (url: string) => {
        requested.push(url);
        if (url === LISTING_URL) return listing;
        if (url === detailUrl) return DETAIL_HTML;
        throw new Error(`Unexpected URL ${url}`);
      },
      sleep: async () => {},
    });

    expect(requested).toEqual([LISTING_URL, detailUrl]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      companyKey: CRR_KEY,
      title: 'MP-E Intern',
      location: 'Sion',
      canton: 'VS',
      postalCode: '1950',
      streetAddress: 'Avenue Grand Champsec 90',
      addressCountry: 'CH',
      url: detailUrl,
      applyUrl: detailUrl,
      sourceLang: 'en',
      needsRetranslation: true,
      contract: 'internship',
      employmentType: 'FULL_TIME',
      postingDateSource: 'reported',
    });
    expect(jobs[0].description).toContain('Take your first professional steps');
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(jobs[0].datePosted).toContain('2026-11-12');
  });
});
