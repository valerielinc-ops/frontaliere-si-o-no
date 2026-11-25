import { afterEach, expect, it, vi } from 'vitest';
import { fetchAllCrrJobs } from '../scripts/lib/crr-suva-sion-job-parser.mjs';
import { fetchAllKlinikSusenbergJobs } from '../scripts/lib/klinik-susenberg-job-parser.mjs';
import { fetchAllKsmlJobs } from '../scripts/lib/ksml-job-parser.mjs';
import { fetchAllPsgnJobs } from '../scripts/lib/psgn-job-parser.mjs';
import { extractPdfJobContentFromUrl } from '../scripts/lib/pdf-job-content.mjs';

vi.mock('../scripts/lib/pdf-job-content.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/pdf-job-content.mjs')>(),
  extractPdfJobContentFromUrl: vi.fn(),
}));
const UNKNOWN = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const BODY = 'Wir betreuen unsere Patientinnen und Patienten während der stationären Behandlung und begleiten ihre Familien mit grossem Engagement. Sie planen die therapeutischen Massnahmen selbständig, dokumentieren die Fortschritte und arbeiten eng mit dem ärztlichen Dienst zusammen. Wir wünschen uns eine abgeschlossene Ausbildung sowie Erfahrung in der interdisziplinären Zusammenarbeit. Unser Team unterstützt Sie während der Einführung und bietet regelmässige Weiterbildung sowie einen abwechslungsreichen Arbeitsalltag im regionalen Spital mit moderner Infrastruktur.';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['15.06.2020', '31.02.2020', '15.06.2999'])('CRR does not promote unlabelled/start date %s', async (raw) => {
  const url = 'https://www.jobup.ch/en/jobs/detail/12345678-1234-4234-8234-123456789abc/';
  const listing = `<a class="post-link" href="${url}"><h3 class="post-title">Infirmier</h3><span class="post-resume-wrapper">Sion · 80%</span></a>`;
  const detail = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Infirmier',
    description: BODY,
    jobStartDate: raw,
    hiringOrganization: { '@type': 'Organization', name: 'Clinique romande de réadaptation' },
    employmentType: 'Permanent position',
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', streetAddress: 'Avenue Grand Champsec 90', addressRegion: 'Sion', postalCode: '1950', addressCountry: 'CH' } },
  })}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === url ? detail : listing)));
  const jobs = await fetchAllCrrJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Infirmier', url, location: 'Sion', canton: 'VS', description: BODY });
});
it('CRR only follows Jobup vacancy cards from the current listing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<a class="post-link" href="https://www.jobup.ch/en/companies/example/">Introduction</a>')));
  expect(await fetchAllCrrJobs()).toEqual([]);
});

it.each(['', '_2020-06-15', '_2020-02-31', '_2999-06-15'])('Susenberg filename suffix %s is not publication evidence', async (suffix) => {
  const path = `/fileadmin/user_upload/Stellen/Pflege${suffix}.pdf`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`<h2 class="hf-header">Pflege</h2><a class="download-link-linkicon" href="${path}" title="Pflegefachperson">PDF</a>`)));
  vi.mocked(extractPdfJobContentFromUrl).mockResolvedValue({ rawText: BODY, text: BODY, thin: false, totalPages: 1, sourceUrl: `https://www.susenbergklinik.ch${path}` });
  const jobs = await fetchAllKlinikSusenbergJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Pflegefachperson', location: 'Zürich', canton: 'ZH', department: 'Pflege' });
  expect(jobs[0].description).toContain('stationären Behandlung');
  expect(extractPdfJobContentFromUrl).toHaveBeenCalledWith(`https://www.susenbergklinik.ch${path}`, expect.any(Object));
});

it.each([undefined, '2020-06-15 06:57:25.495', '2020-02-31', '2999-06-15', 'invalid'])('KSML creation timestamp %s is not publication evidence', async (erfassungTs) => {
  const row = { stelleId: 123, publikationsstatus: 'PUBLISHED', stelleBase: { stellentitel: 'Lehrperson', inseratesprache: '1', erfassungTs, aufgaben: BODY, adresseOrg: { plzOrt: { plz: '3000', ort: 'Bern' } } } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([row]))));
  const jobs = await fetchAllKsmlJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Lehrperson', location: 'Bern', canton: 'BE', slugDisambiguator: '123' });
  expect(jobs[0].description).toContain(BODY);
});

it.each(['', '2020-06-15', '2999-06-15'])('PSGN does not replace missing publication with crawl time or validThrough %s', async (validThrough) => {
  const url = 'https://jobs.psychiatrie-sg.ch/karriere/offene-stellen/pflege/12345678-1234-1234-1234-123456789abc';
  const listing = `<a class="job" href="${url}"><div class="jobTitle"><h2>Pflegefachperson</h2></div><div class="jobArbeitsOrt">Wil SG</div></a>`;
  const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Pflegefachperson', validThrough, responsibilities: BODY })}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === url ? detail : listing)));
  const jobs = await fetchAllPsgnJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Pflegefachperson', url, location: 'Wil SG', canton: 'SG' });
  expect(jobs[0].description).toContain(BODY);
});
