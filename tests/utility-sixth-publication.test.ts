import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllLhmJobs } from '../scripts/lib/lhm-luzerner-hohenklinik-montana-job-parser.mjs';
import { fetchAllMabetexJobs } from '../scripts/lib/mabetex-job-parser.mjs';
import { fetchAllMarriottJobs } from '../scripts/lib/marriott-job-parser.mjs';
const title = 'Fachperson Pflege';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const kind of ['valid', 'missing', 'invalid', 'future', 'creation-only', 'other-title', 'foreign-url', 'foreign-sameas', 'ambiguous']) {
  it(`LHM same detail provenance ${kind}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const raw = ['valid', 'other-title', 'foreign-url', 'foreign-sameas', 'ambiguous'].includes(kind) ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
    const url = 'https://www.lhm.ch/de/allgemein/jobs/fachperson';
    const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Other' : title, url: kind === 'ambiguous' ? undefined : kind === 'foreign-url' ? 'https://wrong.example/other' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/other' : undefined, datePosted: raw, dateCreated: `${year}-01-01` };
    const detail = `<script type="application/ld+json">${JSON.stringify(kind === 'ambiguous' ? [posting, { ...posting, datePosted: `${year}-01-01` }] : posting)}</script><h1>${title}</h1><div class="content_overflow"><p>${body}</p></div>`;
    const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : `<a href="${url}">${title}</a>`, { status: 200 }));
    vi.stubGlobal('fetch', transport); const pending = fetchAllLhmJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : unknown);
    expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].url).toBe(url); expect(transport).toHaveBeenCalledTimes(2);
  });
}
for (const start of ['', '1 January 2025', '1 January 2999']) {
  it(`Mabetex employment start ${start} is not publication`, async () => {
    const transport = vi.fn(async () => new Response(`<div class="et_pb_text_inner"><h2>Job offers</h2><p><strong>PROJECT MANAGER</strong></p><p>Place of work: Lugano</p><p>Starting date: ${start}</p><p><strong>JOB DESCRIPTION</strong></p><p>${body}</p></div>`, { status: 200 }));
    vi.stubGlobal('fetch', transport); const jobs = await fetchAllMabetexJobs(); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(unknown); expect(jobs[0].description).toContain('engagierten Team'); expect(transport).toHaveBeenCalledTimes(1);
  });
}
for (const date of [undefined, '2025-01-01', '2999-01-01']) {
  it(`Marriott ambiguous creation/start ${date} is not publication`, async () => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(init?.method === 'POST' ? JSON.stringify({ totalJob: 1, jobs: [{ title, uniqueID: 'fixture', originalURL: 'https://careers.marriott.com/jobs/fixture', description: body, createdAt: date, startDate: date, locations: [{ city: 'Zurich', stateAbbr: 'ZH', country: 'Switzerland' }] }] }) : '<html></html>', { status: 200 }));
    vi.stubGlobal('fetch', transport); const pending = fetchAllMarriottJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(unknown); expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].crawledAt).toBeTruthy(); expect(transport).toHaveBeenCalledTimes(2);
  });
}
