import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HFR_COMPANY_NAME,
  HFR_KEY,
  HFR_ORACLE_BASE,
  HFR_ORACLE_SITE,
  fetchAllHfrJobs,
  isHfrJob,
  isTrustedDomain,
} from '../scripts/lib/hfr-hopital-fribourgeois-job-parser.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const SOURCE_DESCRIPTION = [
  'L’hôpital fribourgeois recherche une personne motivée pour rejoindre son équipe de soins à Fribourg.',
  'La mission comprend la prise en charge des patientes et patients, la coordination avec les équipes interdisciplinaires,',
  'la participation aux projets du service et le respect des procédures de qualité et de sécurité.',
  'Nous offrons un environnement bilingue, des possibilités de formation continue, des conditions de travail attractives',
  'et un accompagnement professionnel au sein d’une institution publique engagée dans la santé régionale.',
].join(' ');

const oracleRequisition = (id: number) => ({
  Id: String(id),
  Title: `HFR requisition ${id}`,
  PrimaryLocation: 'Fribourg, Switzerland',
  PrimaryLocationCountry: 'CH',
});

const oracleOffset = (url: string) => Number(
  new URL(url).searchParams.get('finder')?.match(/(?:^|,)offset=(\d+)/)?.[1] || 0,
);

describe('HFR Oracle HCM crawler parser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches migrated records and trusts only HFR/Oracle job URLs', () => {
    expect(HFR_KEY).toBe('hfr-hopital-fribourgeois');
    expect(HFR_COMPANY_NAME).toBe('Hôpital fribourgeois (HFR)');
    expect(isHfrJob({ companyKey: HFR_KEY })).toBe(true);
    expect(isHfrJob({ url: 'https://hopital-fribourgeois.breezy.hr/p/legacy' })).toBe(true);
    expect(isHfrJob({ url: `${HFR_ORACLE_BASE}/hcmUI/CandidateExperience/fr/sites/${HFR_ORACLE_SITE}/job/1001` })).toBe(true);
    expect(isHfrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.example/jobs' })).toBe(false);

    expect(isTrustedDomain('https://www.h-fr.ch/le-reseau-hfr/nos-offres-demploi/')).toBe(true);
    expect(isTrustedDomain(`${HFR_ORACLE_BASE}/hcmUI/CandidateExperience/fr/sites/${HFR_ORACLE_SITE}/job/1001`)).toBe(true);
    expect(isTrustedDomain('https://fa-other-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/fr/sites/CX_1/job/1001')).toBe(false);
  });

  it('reads Oracle requisitions, fetches source-backed detail text, and filters foreign rows', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes('/recruitingCEJobRequisitionDetails/1001')) {
        return new Response(JSON.stringify({
          ExternalDescriptionStr: `<div>${SOURCE_DESCRIPTION}</div>`,
          ExternalPostedStartDate: daysAgo(3),
        }), { status: 200 });
      }
      if (url.includes('/recruitingCEJobRequisitions?')) {
        return new Response(JSON.stringify({
          items: [{
            TotalJobsCount: 2,
            requisitionList: [
              {
                Id: '1001',
                Title: 'Infirmier-ère diplômé-e',
                PrimaryLocation: 'Fribourg, Switzerland',
                PrimaryLocationCountry: 'CH',
                ShortDescriptionStr: 'Résumé de l’offre.',
                PostedDate: daysAgo(3),
              },
              {
                Id: '1002',
                Title: 'Nurse outside Switzerland',
                PrimaryLocation: 'Paris, France',
                PrimaryLocationCountry: 'FR',
                ShortDescriptionStr: SOURCE_DESCRIPTION,
                PostedDate: daysAgo(2),
              },
            ],
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    const result = await fetchAllHfrJobs();

    expect(result.fetchOutcome).toBe('ok');
    expect(result.discoveredCount).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      companyKey: HFR_KEY,
      title: 'Infirmier-ère diplômé-e',
      location: 'Fribourg, Switzerland',
      canton: 'FR',
      postalCode: '1708',
      addressCountry: 'CH',
      jobReqId: '1001',
      url: `${HFR_ORACLE_BASE}/hcmUI/CandidateExperience/fr/sites/${HFR_ORACLE_SITE}/job/1001`,
      datePosted: daysAgo(3),
      postingDateSource: 'reported',
    });
    expect(result.jobs[0].description).toBe(SOURCE_DESCRIPTION);
    expect(result.jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(requestedUrls.filter((url) => url.includes('/recruitingCEJobRequisitionDetails/'))).toHaveLength(1);
  });

  it('reports a malformed Oracle envelope as selector_miss instead of a valid empty board', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const result = await fetchAllHfrJobs();

    expect(result).toMatchObject({
      jobs: [],
      fetchOutcome: 'selector_miss',
    });
  });

  it.each(['a malformed second page', 'a repeated full second page'])(
    'fails closed after a full first page followed by %s without a total count',
    async (secondPageKind) => {
      const firstPage = Array.from({ length: 50 }, (_, index) => oracleRequisition(index + 1));
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (!url.includes('/recruitingCEJobRequisitions?')) return new Response('', { status: 404 });
        if (oracleOffset(url) === 0) {
          return new Response(JSON.stringify({ items: [{ requisitionList: firstPage }] }), { status: 200 });
        }
        const secondPage = secondPageKind === 'a malformed second page'
          ? { data: [] }
          : { items: [{ requisitionList: firstPage }] };
        return new Response(JSON.stringify(secondPage), { status: 200 });
      }));

      const result = await fetchAllHfrJobs();

      expect(result).toMatchObject({
        jobs: [],
        fetchOutcome: 'selector_miss',
      });
    },
  );

  it('fails closed when every discovered requisition lacks a publishable source body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/recruitingCEJobRequisitionDetails/1001')) {
        return new Response('', { status: 404 });
      }
      if (url.includes('/recruitingCEJobRequisitions?')) {
        return new Response(JSON.stringify({
          items: [{
            requisitionList: [{
              ...oracleRequisition(1001),
              ShortDescriptionStr: 'Offerta breve.',
            }],
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    const result = await fetchAllHfrJobs();

    expect(result).toEqual({
      jobs: [],
      discoveredCount: 1,
      fetchOutcome: 'selector_miss',
    });
  });
});
