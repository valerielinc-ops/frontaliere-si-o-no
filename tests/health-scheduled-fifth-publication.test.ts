import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllHochgebirgsklinikDavosJobs } from '../scripts/lib/hochgebirgsklinik-davos-job-parser.mjs';
import { fetchAllHopitalDeLavauxJobs } from '../scripts/lib/hopital-de-lavaux-job-parser.mjs';
import { fetchAllHvsJobs } from '../scripts/lib/hopital-du-valais-job-parser.mjs';
import { fetchAllInstitutionLavignyJobs } from '../scripts/lib/institution-lavigny-job-parser.mjs';
import { fetchAllKispiSgJobs } from '../scripts/lib/kispi-sg-job-parser.mjs';
const body = 'Les professionnels assurent les soins aux patients dans une équipe multidisciplinaire attentive. '.repeat(20);
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', datePosted: date, dateCreated: '2026-09-01', jobStartDate: '2026-09-02', validThrough: '2030-12-31' })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const kispiBody = readFileSync(new URL('./fixtures/kispi-sg/detail-praktikum-pflege.html', import.meta.url), 'utf8');
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'bad-date', ''],
  ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function verify(job: { postedDate: string; datePosted: string; postingDateSource: string; description: string; url: string; slug: string }, expected: string) {
  expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  expect(job.description.length).toBeGreaterThan(100);
  expect(job.url).toMatch(/^https:\/\//);
  expect(job.slug.length).toBeGreaterThan(3);
}

describe('Davos publication from the actual public vacancy, not Typesense creation', () => {
  it.each([...cases, ['HTTP404', null, ''] as const])('%s', async (_, raw, expected) => {
    const detailUrl = 'https://karriere.hochgebirgsklinik.ch/jobs/infirmier/id-123';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url === detailUrl) return raw === null ? new Response('', { status: 404 }) : new Response(ld(raw));
      if (url.includes('x-typesense-api-key=')) return Response.json({ results: [{ found: 1, hits: [{ document: { id: '123', title: 'Diplomierte Pflegefachperson', description: body, location: ['Davos'], url: detailUrl, application_url: 'https://recruitingapp-2932.umantis.com/Vacancies/123/Application/', create_date: '01.09.2026, 08:30:00', last_modified: '02.09.2026', start_date: '03.09.2026', schema_values: {} } }] }] });
      const nuxt = [{}, {}, {}, { 'typesenseApiKey-9c3b04cb-7265-5acb-a208-199c8a9d547a': 4 }, 'test-public-key-abcdefghijklmnopqrstuvwxyz'];
      return new Response(`<script id="__NUXT_DATA__">${JSON.stringify(nuxt)}</script>`);
    });
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllHochgebirgsklinikDavosJobs();
    expect(jobs).toHaveLength(1); verify(jobs[0], expected);
    expect(jobs[0].applyUrl).toContain('/Vacancies/123/Application/');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Valais published field through ServiceNow fetch pipeline', () => {
  it.each(cases)('%s does not borrow date_debut', async (_, raw, expected) => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))[0];
      const output = request.pipelineId.includes('total') ? [{ RowCount: 1 }]
        : request.pipelineId.includes('selected') ? [{ mission: body, profil: body }]
          : [{ sys_id: 'abc123', u_titre: 'Infirmier diplômé', u_site: 'Sion', u_description: body, u_date_published: raw, u_date_debut: '01.09.2026', u_date_fin: '31.12.2030' }];
      return Response.json({ result: [{ executionResult: { output } }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllHvsJobs();
    expect(jobs).toHaveLength(1); verify(jobs[0], expected);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Lavigny scopes publication to the vacancy block', () => {
  it.each(cases)('%s never borrows neighbouring metadata', async (_, raw, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${ld('2026-09-01')}<main><div id="main_abc"><h5><b>Infirmier diplômé</b></h5><div>Site Lavigny</div><div>CDI</div><div>1175 Lavigny</div>${ld(raw)}<div id="detailoffreabc">${body}<a class="jobup_connect" href="https://www.jobup.ch/fr/emplois/detail/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/">Postuler</a></div></div></main>`)));
    const jobs = await fetchAllInstitutionLavignyJobs();
    expect(jobs).toHaveLength(1); verify(jobs[0], expected);
    expect(jobs[0].applyUrl).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('Kispi SG keeps detail publication while preserving source body', () => {
  it.each(cases)('%s', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(urlOf(input).endsWith('/stellen')
      ? '<p class="h1" data-id="123">Pflegefachperson</p><a href="/de/stellen/pflege-123">Details</a>'
      : ld(raw) + kispiBody));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllKispiSgJobs();
    expect(jobs).toHaveLength(1); verify(jobs[0], expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Lavaux observed API has no publication evidence', () => {
  it.each(['', '2026-09-01', '2030-01-01'])('does not promote created/expiry value %s', async (otherDate) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ campaigns: [{ _id: '123', title: { '1': 'Infirmier diplômé' }, description: { '1': body }, language: 1, inviteLink: 'https://app.beehire.com/invite/example', createdAt: otherDate, inviteExp: otherDate, location: { city: 'Cully', state: 'VD' } }] })));
    const jobs = await fetchAllHopitalDeLavauxJobs();
    expect(jobs).toHaveLength(1); verify(jobs[0], '');
    expect(jobs[0].applyUrl).toBe('https://app.beehire.com/invite/example');
  });
});
