import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ page: vi.fn(), html: vi.fn(), launch: vi.fn(), fetch: vi.fn() }));
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: io.fetch }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({ ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(), politeFetch: io.page }));
vi.mock('../scripts/lib/ensure-chromium.mjs', async original => ({ ...await original<typeof import('../scripts/lib/ensure-chromium.mjs')>(), launchChromium: io.launch }));
import { fetchAllMedIpersonalJobs } from '../scripts/lib/med-ipersonal-job-parser.mjs';
import { fetchAllMichaelpageJobs } from '../scripts/lib/michaelpage-job-parser.mjs';
import { fetchAllOkjobJobs } from '../scripts/lib/okjob-job-parser.mjs';
import { fetchAllMigrolinoJobs } from '../scripts/lib/migrolino-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.page.mockReset(); io.html.mockReset(); io.launch.mockReset(); io.fetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
for (const key of ['med', 'michaelpage', 'okjob', 'migrolino'] as const) describe(`${key} actual producer source dates`, () => {
  it.each(cases)('validates source %s', async (raw, expected) => {
    const href = '/de/unsere-unternehmen/job/migrolino/fachperson/12345678-1234-1234-1234-123456789012';
    const url = ({ med: 'https://www.ipersonal.ch/jobs/fachperson-lugano/', michaelpage: 'https://www.pageexecutive.com/job-detail/fachperson/ref/123', okjob: 'https://www.okjob.ch/offres-demplois/fachperson/', migrolino: `https://jobs.migros.ch${href}` })[key];
    const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Fachperson Engineering', description: prose, datePosted: raw, dateModified: '2026-09-28', hiringOrganization: { '@type': 'Organization', name: key === 'migrolino' ? 'migrolino AG' : 'Source employer' }, jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH' } } })}</script>${key === 'michaelpage' ? `<span class="job-location">Lugano, Switzerland</span><section class="job_advert__job-desc-role"><p>${prose}</p></section>` : ''}<main><h1>Fachperson Engineering</h1><p>${prose}</p></main>`;
    io.page.mockImplementation(async (requested: string) => ({ ok: true, status: 200, url: requested, body: requested === url ? detail : `<a href="${url}">Fachperson Engineering</a>` }));
    io.html.mockResolvedValue(detail);
    const close = vi.fn(async () => {});
    const page = { goto: vi.fn(async () => {}), waitForTimeout: vi.fn(async () => {}), evaluate: vi.fn(async () => [href]), locator: () => ({ first: () => ({ isVisible: async () => false, isDisabled: async () => true }) }) };
    io.launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => page }), close });
    const jobs = await ({ med: fetchAllMedIpersonalJobs, michaelpage: fetchAllMichaelpageJobs, okjob: fetchAllOkjobJobs, migrolino: fetchAllMigrolinoJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url, datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    if (key === 'migrolino') expect(close).toHaveBeenCalledOnce();
  });
});

for (const reported of [true, false]) it(`Med iPersonal preserves only proven previous dates after failed detail (${reported})`, async () => {
  const url = 'https://www.ipersonal.ch/jobs/previous-lugano/';
  const description = `${prose}\n• Ergebnisse zuverlässig dokumentieren`;
  const accepted = Array.from({ length: 6 }, (_, index) => `https://www.ipersonal.ch/jobs/accepted-${index}/`);
  io.fetch.mockImplementation(async (input: string) => {
    const requested = String(input);
    if (requested === url) return new Response('temporary outage', { status: 404 });
    if (accepted.includes(requested)) return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url: requested, title: `Fachperson Engineering ${accepted.indexOf(requested)}`, description, datePosted: '2026-09-29T10:00:00Z', jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH' } } })}</script><section class="job-profile-section"><div id="Jobdetails"><p>${prose}</p><h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul></div></section>`);
    return new Response([...accepted, url].map(href => `<a href="${href}">Fachperson Engineering</a>`).join(''));
  });
  io.page.mockImplementation(async (requested: string, options: { fetchImpl?: typeof fetch }) => {
    const response = await (options.fetchImpl || io.fetch)(requested);
    return { ok: response.ok, status: response.status, url: requested, body: await response.text() };
  });
  const previous = { url, title: 'Fachperson Engineering', description, descriptionByLocale: { de: description }, sourceLang: 'de', location: 'Lugano', canton: 'TI', addressCountry: 'CH', postedDate: '2026-09-29T10:00:00Z', ...(reported ? { datePosted: '2026-09-29T10:00:00Z', postingDateSource: 'reported' } : {}) };
  const jobs = await fetchAllMedIpersonalJobs({ existingJobs: [previous] });
  expect(jobs).toHaveLength(7);
  const date = reported ? '2026-09-29T10:00:00Z' : '';
  expect(jobs.find(job => job.url === url)).toMatchObject({ url, datePosted: date, postedDate: date, postingDateSource: reported ? 'reported' : 'unknown' });
});
