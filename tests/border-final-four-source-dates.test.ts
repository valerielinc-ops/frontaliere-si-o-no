import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchAllTriaplusJobs } from '../scripts/lib/triaplus-job-parser.mjs';
import { fetchAllVitreaGesundheitJobs } from '../scripts/lib/vitrea-gesundheit-job-parser.mjs';
import { fetchAllWagerenhofJobs } from '../scripts/lib/wagerenhof-job-parser.mjs';
import { fetchAllWeisseArenaJobs } from '../scripts/lib/weisse-arena-job-parser.mjs';
const UNKNOWN = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const BODY = 'Wir betreuen unsere Patientinnen und Patienten während der stationären Behandlung und begleiten ihre Familien mit grossem Engagement. Sie planen die therapeutischen Massnahmen selbständig, dokumentieren die Fortschritte und arbeiten eng mit dem ärztlichen Dienst zusammen. Wir wünschen uns eine abgeschlossene Ausbildung sowie Erfahrung in der interdisziplinären Zusammenarbeit. Unser Team unterstützt Sie während der Einführung und bietet regelmässige Weiterbildung sowie einen abwechslungsreichen Arbeitsalltag im regionalen Spital mit moderner Infrastruktur.';
afterEach(() => vi.unstubAllGlobals());

for (const metadata of ['', '<meta name="dateModified" content="2020-06-15"><p>Erstellt am 15.06.2020</p>']) {
  it(`Triaplus emits unknown without losing source location ${metadata}`, async () => {
    const url = 'https://karriere.triaplus.ch/jobs/pflegefachperson/';
    const listing = `<a href="${url}">Pflegefachperson</a>`;
    const detail = `<title>Pflegefachperson | Triaplus AG</title><div class="section titel"><h2 class="has-d-3-font-size jobtitel">Pflegefachperson<br><span class="ort">in Baar</span></h2></div><h3>Ihre Aufgaben beinhalten</h3><p>${BODY}</p><div class="cta-content">apply</div>${metadata}`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === url ? detail : listing)));
    const jobs = await fetchAllTriaplusJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, location: 'Baar', canton: 'ZG', url });
  });
  it(`Vitrea preserves the native full advertisement and unknown date ${metadata}`, async () => {
    const listing = '<a data-testid="job-card" aria-label="Physiotherapeut" href="/de/job/physio-test"><h3 data-testid="job-title">Physiotherapeut</h3><span data-testid="job-location">Seewis</span></a>';
    const ad = readFileSync(new URL('./fixtures/vitrea-gesundheit/job-ad-full.html', import.meta.url), 'utf8');
    const fetchMock = vi.fn(async (input: string | URL) => new Response(String(input).includes('/job/show/') ? ad + metadata : listing));
    vi.stubGlobal('fetch', fetchMock);
    const jobs = await fetchAllVitreaGesundheitJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, companyKey: 'vitrea-gesundheit', title: 'Physiotherapeut' });
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/job/show/physio-test/full'))).toBe(true);
  });
  it(`Wagerenhof does not promote an unlabelled dateLabel ${metadata}`, async () => {
    const url = 'https://www.wagerenhof.ch/vacancy-details?reference=ref-123';
    const listing = `<a href="${url}"><span class="job-title">Pflegefachperson</span><span class="job-count">15.06.2020</span></a>`;
    const detail = `<h1>Pflegefachperson</h1><p>${BODY}</p>${metadata}`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input).includes('vacancy-details') ? detail : listing)));
    const jobs = await fetchAllWagerenhofJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, location: 'Uster', canton: 'ZH', url });
    expect(jobs[0].description).toContain('stationären Behandlung');
  });
}

const listing = (raw: unknown, id = 4484) => ({ id, jobFields: { id, jobNumber: 'WAG02350', jobTitle: 'Marketing Manager', DPOSTINGSTART: raw,
  SLOVLIST10: 'Marketing', SLOVLIST17: '80%-100%', CONTRACTTYPLABEL: 'Festanstellung' },
  customFields: [{ title: 'Ihre Aufgaben', content: `<p>${BODY}</p>` }] });
describe('Weisse Arena uncorroborated provider start field', () => {
  it.each([undefined, null, 1774908000000, 'invalid', 32503680000000])('keeps DPOSTINGSTART %s unknown through API → builder', async (raw) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ globals: { jobsCount: 1 }, jobs: [listing(raw)] }), { headers: { 'Content-Type': 'application/json' } })));
    const jobs = await fetchAllWeisseArenaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Marketing Manager', location: 'Laax', canton: 'GR' });
    expect(jobs[0].description).toContain('stationären Behandlung');
  });
  it('preserves stable jobNumber identity on recrawl without manufacturing a date', async () => {
    let id = 4484;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ globals: { jobsCount: 1 }, jobs: [listing(1774908000000, id)] }))));
    const before = await fetchAllWeisseArenaJobs();
    id = 4485;
    const after = await fetchAllWeisseArenaJobs();
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(before[0]).toMatchObject(UNKNOWN);
    expect(after[0]).toMatchObject(UNKNOWN);
  });
});
