import { describe, expect, it } from 'vitest';
import {
  extractOfficialWidgetUrl,
  extractTechnicEmploisListings,
  fetchAllTechnicEmploisJobs,
  isTechnicDetailUrl,
  isTechnicEmploisJob,
  isTrustedDomain,
  TECHNIC_EMPLOIS_KEY,
} from '../scripts/lib/technic-emplois-job-parser.mjs';

const OFFICIAL = 'https://technic-emplois.ch/offre-demploi/';
const WIDGET = 'https://blog.jobeo.ch/technicemploi/';
const DETAIL = 'https://www.jobeo.ch/candidat/offres/offre-d-emploi-soudeur-tuyauteur-123/';

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
  allowedDetailOrigins: ['https://jobeo.ch', 'https://www.jobeo.ch'],
  detailTemplate: '/candidat/offres/offre-d-emploi-*',
  detailEnrichment: true,
  detailFetchWorkers: 2,
  canton: 'GE',
  sourceLang: 'fr',
};

describe('Technic Emplois crawler parser', () => {
  it('extracts only the tenant iframe from the official page', () => {
    const html = '<iframe src="https://example.com/video"></iframe>'
      + `<iframe src="${WIDGET}"></iframe>`;
    expect(extractOfficialWidgetUrl(html, OFFICIAL)).toBe(WIDGET);
  });

  it('requires a Jobeo vacancy path and rejects aggregator links', () => {
    expect(isTechnicDetailUrl(DETAIL)).toBe(true);
    expect(isTechnicDetailUrl(WIDGET)).toBe(false);
    expect(isTechnicDetailUrl('https://jobup.ch/fr/emplois/soudeur-123/')).toBe(false);
    expect(isTrustedDomain(DETAIL)).toBe(true);
    expect(isTrustedDomain('https://jobup.ch/fr/emplois/soudeur-123/')).toBe(false);
  });

  it('keeps only explicit Jobeo detail links from the embedded feed', () => {
    const html = `<a href="${DETAIL}">Soudeur / Tuyauteur</a>`
      + '<a href="https://jobup.ch/fr/emplois/soudeur-123/">Soudeur</a>'
      + '<a href="https://jobs.ch/en/vacancies/detail/soudeur-123/">Soudeur</a>';
    expect(extractTechnicEmploisListings(html, WIDGET)).toEqual([
      expect.objectContaining({ title: 'Soudeur / Tuyauteur', url: DETAIL }),
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
      spec,
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
});
