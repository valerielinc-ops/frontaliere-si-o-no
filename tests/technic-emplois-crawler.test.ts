import { describe, expect, it } from 'vitest';
import {
  extractOfficialWidgetUrl,
  extractTechnicEmploisListings,
  fetchAllTechnicEmploisJobs,
  extractTechnicJobupListings,
  isTechnicDetailUrl,
  isTechnicEmploisJob,
  isTrustedDomain,
  TECHNIC_EMPLOIS_KEY,
  TECHNIC_EMPLOIS_JOBUP_SEARCH_URL,
} from '../scripts/lib/technic-emplois-job-parser.mjs';

const OFFICIAL = 'https://technic-emplois.ch/offre-demploi/';
const WIDGET = 'https://blog.jobeo.ch/technicemploi/';
const DETAIL = 'https://www.jobeo.ch/candidat/offres/offre-d-emploi-soudeur-tuyauteur-123/';
const JOBUP_DETAIL = 'https://www.jobup.ch/fr/emplois/detail/11111111-2222-3333-4444-555555555555/';
const OTHER_JOBUP_DETAIL = 'https://www.jobup.ch/fr/emplois/detail/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/';

const DESCRIPTION = [
  'Technic Emplois SA recherche un soudeur tuyauteur pour renforcer une équipe technique à Genève.',
  'Vous préparez les pièces, réalisez les travaux de soudage et contrôlez la qualité des assemblages.',
  'Le poste demande une expérience pratique, de la précision, un esprit d équipe et le respect des règles de sécurité.',
  'La mission est proposée à plein temps avec une prise de fonction selon disponibilité.',
].join(' ');

const SPEC = {
  companyKey: TECHNIC_EMPLOIS_KEY,
  companyName: 'Technic Emplois SA',
  companyHost: 'technic-emplois.ch',
  platform: 'jobeo.ch',
  mode: 'template',
  seedUrls: [OFFICIAL, WIDGET],
  allowedDetailOrigins: ['https://jobeo.ch', 'https://www.jobeo.ch', 'https://jobup.ch', 'https://www.jobup.ch'],
  detailTemplate: '/fr/emplois/detail/*',
  detailEnrichment: true,
  detailFetchWorkers: 2,
  canton: 'GE',
  sourceLang: 'fr',
};

const JOBUP_SEARCH_HTML = `
  <a data-cy="job-link" href="/fr/emplois/detail/11111111-2222-3333-4444-555555555555/">
    <span class="textStyle_body2">Monteur électricien</span>
    <span>Lieu de travail<!-- -->:</span><p>Genève</p>
    <span>Taux d'activité<!-- -->:</span><p>100%</p>
    <span>Type de contrat<!-- -->:</span><p>Temporaire</p>
    <p class="c_gray.700 fw_bold">Technic Emplois SA</p>
  </a>
  <a data-cy="job-link" href="/fr/emplois/detail/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/">
    <span class="textStyle_body2">Electricien</span>
    <span>Lieu de travail<!-- -->:</span><p>Lausanne</p>
    <span>Taux d'activité<!-- -->:</span><p>100%</p>
    <span>Type de contrat<!-- -->:</span><p>Temporaire</p>
    <p class="c_gray.700 fw_bold">Other Employer SA</p>
  </a>`;

describe('Technic Emplois crawler parser', () => {
  it('extracts only the tenant iframe from the official page', () => {
    const html = '<iframe src="https://example.com/video"></iframe>'
      + `<iframe src="${WIDGET}"></iframe>`;
    expect(extractOfficialWidgetUrl(html, OFFICIAL)).toBe(WIDGET);
  });

  it('requires a Jobeo vacancy path and rejects aggregator links', () => {
    expect(isTechnicDetailUrl(DETAIL)).toBe(true);
    expect(isTechnicDetailUrl(JOBUP_DETAIL)).toBe(true);
    expect(isTechnicDetailUrl(WIDGET)).toBe(false);
    expect(isTechnicDetailUrl('https://jobup.ch/fr/emplois/soudeur-123/')).toBe(false);
    expect(isTrustedDomain(DETAIL)).toBe(true);
    expect(isTrustedDomain(JOBUP_DETAIL)).toBe(true);
    expect(isTrustedDomain('https://jobs.ch/en/vacancies/detail/soudeur-123/')).toBe(false);
  });

  it('keeps only explicit Jobeo detail links from the embedded feed', () => {
    const html = `<a href="${DETAIL}">Soudeur / Tuyauteur</a>`
      + '<a href="https://jobup.ch/fr/emplois/soudeur-123/">Soudeur</a>'
      + '<a href="https://jobs.ch/en/vacancies/detail/soudeur-123/">Soudeur</a>';
    expect(extractTechnicEmploisListings(html, WIDGET)).toEqual([
      expect.objectContaining({ title: 'Soudeur / Tuyauteur', url: DETAIL }),
    ]);
  });

  it('keeps only the exact employer from the current Jobup search', () => {
    expect(extractTechnicJobupListings(JOBUP_SEARCH_HTML, TECHNIC_EMPLOIS_JOBUP_SEARCH_URL)).toEqual([
      expect.objectContaining({
        title: 'Monteur électricien',
        company: 'Technic Emplois SA',
        url: JOBUP_DETAIL,
        location: 'Genève',
        locationCandidates: [expect.objectContaining({
          addressLocality: 'Genève',
          addressCountry: 'CH',
        })],
      }),
    ]);
  });

  it('publishes a source-backed Geneva vacancy from the official iframe', async () => {
    const detailHtml = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Soudeur / Tuyauteur',
      url: DETAIL,
      description: DESCRIPTION,
      datePosted: '2026-08-14',
      employmentType: 'TEMPORARY',
      hiringOrganization: { '@type': 'Organization', name: 'Technic Emplois SA' },
      jobLocation: { '@type': 'Place', address: {
        '@type': 'PostalAddress',
        addressLocality: 'Genève',
        addressRegion: 'GE',
        addressCountry: 'CH',
        postalCode: '1200',
      } },
    })}</script>`;
    const pages = new Map([
      [OFFICIAL, `<iframe src="${WIDGET}"></iframe>`],
      [WIDGET, `<a href="${DETAIL}">Soudeur / Tuyauteur</a>`],
      [DETAIL, detailHtml],
    ]);

    const jobs = await fetchAllTechnicEmploisJobs({
      spec: SPEC,
      runtime: { fetchPageImpl: async (url: string) => pages.get(url) || '' },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      company: 'Technic Emplois SA',
      companyKey: 'technic-emplois',
      title: 'Soudeur / Tuyauteur',
      canton: 'GE',
      location: 'Genève, GE',
      addressLocality: 'Genève',
      addressRegion: 'GE',
      addressCountry: 'CH',
      postalCode: '1200',
      url: DETAIL,
      datePosted: '2026-08-14',
      postingDateSource: 'reported',
    }));
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(jobs).toHaveProperty('fetchOutcome', 'ok');
    expect(isTechnicEmploisJob(jobs[0])).toBe(true);
  });

  it('uses browser fallback when the raw detail is only a title', async () => {
    const renderedDetail = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Soudeur / Tuyauteur',
      url: DETAIL,
      description: DESCRIPTION,
      hiringOrganization: { '@type': 'Organization', name: 'Technic Emplois SA' },
      jobLocation: { '@type': 'Place', address: {
        '@type': 'PostalAddress',
        addressLocality: 'Genève',
        addressRegion: 'GE',
        addressCountry: 'CH',
        postalCode: '1200',
      } },
    })}</script>`;
    const browserUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      const body = url.endsWith('/robots.txt')
        ? 'User-agent: *\nAllow: /'
        : url === OFFICIAL
          ? `<iframe src="${WIDGET}"></iframe>`
          : url === WIDGET
            ? `<a href="${DETAIL}">Soudeur / Tuyauteur</a>`
            : '<h1>Soudeur / Tuyauteur</h1>';
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => null },
        body: { cancel: () => {} },
        text: async () => body,
      } as any;
    };

    const jobs = await fetchAllTechnicEmploisJobs({
      spec: SPEC,
      runtime: {
        fetchImpl,
        browserFetchImpl: async (url: string) => {
          browserUrls.push(url);
          return renderedDetail;
        },
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
      },
    });

    expect(browserUrls).toEqual([DETAIL]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      title: 'Soudeur / Tuyauteur',
      canton: 'GE',
      location: 'Genève, GE',
      url: DETAIL,
    }));
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
  });

  it('falls back to the current Jobup employer search when Jobeo has no listings', async () => {
    const detailHtml = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Monteur électricien',
      url: JOBUP_DETAIL,
      description: DESCRIPTION,
      hiringOrganization: { '@type': 'Organization', name: 'Technic Emplois SA' },
      jobLocation: { '@type': 'Place', address: {
        '@type': 'PostalAddress',
        addressLocality: 'Genève',
        addressRegion: 'GE',
        addressCountry: 'CH',
        postalCode: '1200',
      } },
    })}</script>`;
    const pages = new Map([
      [OFFICIAL, `<iframe src="${WIDGET}"></iframe>`],
      [WIDGET, '<main>legacy Jobeo tenant without current listings</main>'],
      [JOBUP_DETAIL, detailHtml],
    ]);

    const jobs = await fetchAllTechnicEmploisJobs({
      spec: { ...SPEC, seedUrls: [OFFICIAL, WIDGET, TECHNIC_EMPLOIS_JOBUP_SEARCH_URL] },
      runtime: {
        fetchPageImpl: async (url: string) => pages.get(url) || '',
        fetchJobupSearchImpl: async () => JOBUP_SEARCH_HTML,
        browserFetchImpl: async () => '',
      },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      company: 'Technic Emplois SA',
      companyKey: 'technic-emplois',
      title: 'Monteur électricien',
      canton: 'GE',
      location: 'Genève, GE',
      url: JOBUP_DETAIL,
      source: 'Technic Emplois SA (Jobup employer search)',
    }));
    expect(isTechnicEmploisJob(jobs[0])).toBe(true);
  });
});
