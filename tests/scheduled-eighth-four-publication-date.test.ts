import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({ ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(), politeFetch: io.page }));
import { fetchAllRecruitingapp1154Jobs } from '../scripts/lib/recruitingapp-1154-job-parser.mjs';
import { fetchAllRecruitingapp2563Jobs } from '../scripts/lib/recruitingapp-2563-job-parser.mjs';
import { fetchAllRecruitingapp2649Jobs } from '../scripts/lib/recruitingapp-2649-job-parser.mjs';
import { fetchAllRecruitingapp2677Jobs } from '../scripts/lib/recruitingapp-2677-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.page.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
for (const tenant of [1154, 2563, 2649, 2677] as const) describe(`recruitingapp-${tenant} real pipeline`, () => {
  it.each(cases)('validates own source publication %s', async (raw, expected) => {
    const url = `https://recruitingapp-${tenant}.umantis.com/Vacancies/123/Description/1`;
    const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Fachperson Engineering', description: prose, datePosted: raw, jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } } })}</script><h1>Fachperson Engineering</h1><main>${prose}</main>`;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : `<a href="${url}">Fachperson Engineering</a>`));
    // Preserve the production tenant observers while replacing HTTP I/O only.
    io.page.mockImplementation(async (requested: string, options: { fetchImpl: typeof fetch }) => {
      const response = await options.fetchImpl(requested);
      return { ok: response.ok, status: response.status, url: requested, body: await response.text() };
    });
    const jobs = await ({ 1154: fetchAllRecruitingapp1154Jobs, 2563: fetchAllRecruitingapp2563Jobs, 2649: fetchAllRecruitingapp2649Jobs, 2677: fetchAllRecruitingapp2677Jobs })[tenant]({ fetchImpl });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url, datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
