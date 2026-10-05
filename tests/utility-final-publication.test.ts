import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllTzmJobs } from '../scripts/lib/therapiezentrum-meggen-job-parser.mjs';
import { fetchAllThurklinikJobs } from '../scripts/lib/thurklinik-job-parser.mjs';
import { fetchAllVaxcyteJobs } from '../scripts/lib/vaxcyte-job-parser.mjs';
import { fetchAllValiantBankJobs } from '../scripts/lib/valiant-bank-job-parser.mjs';
const pdf = vi.hoisted(() => ({ text: '' }));
vi.mock('../scripts/lib/pdf-job-content.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/pdf-job-content.mjs')>(),
  extractPdfJobContentFromUrl: vi.fn(async () => ({ text: pdf.text, rawText: pdf.text, thin: !pdf.text })),
}));
const title = 'Fachperson Betreuung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8).trim();
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); pdf.text = ''; });
for (const [name, producer] of [['Meggen', fetchAllTzmJobs], ['Thurklinik', fetchAllThurklinikJobs]] as const) {
  for (const kind of ['undated', 'employment-start', 'empty']) {
    it(`${name}: PDF collection never becomes publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      pdf.text = kind === 'empty' ? '' : `${body}${kind === 'employment-start' ? ` Stellenantritt: 1. Januar ${year}` : ''}`;
      const url = name === 'Meggen' ? 'https://www.tzm.ch/app/download/123/pflege.pdf' : 'https://www.thurklinik.ch/wp-content/uploads/pflege.pdf';
      const transport = vi.fn(async () => new Response(`<a href="${url}">${title}</a>`, { status: 200 }));
      vi.stubGlobal('fetch', transport); const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ ...unknown, url });
      expect(jobs[0].crawledAt).toBeTruthy(); expect(jobs[0].description).toBe(kind === 'empty' ? '' : pdf.text);
      expect(transport).toHaveBeenCalledTimes(1);
    });
  }
}
for (const kind of ['valid', 'missing', 'invalid', 'future', 'updated-only']) {
  it(`Vaxcyte: only original first publication ${kind}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const raw = ['missing', 'updated-only'].includes(kind) ? undefined : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : `${year}-06-15T13:00:00+02:00`;
    const url = 'https://job-boards.greenhouse.io/vaxcyte/jobs/123';
    const row = { id: 123, title, content: body, absolute_url: url, location: { name: 'Visp, Switzerland' }, first_published: raw, updated_at: `${year}-07-01T12:00:00Z` };
    const transport = vi.fn(async () => new Response(JSON.stringify({ jobs: [row] }), { status: 200 }));
    vi.stubGlobal('fetch', transport); const pending = fetchAllVaxcyteJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw!.slice(0, 10), postingDateSource: 'reported' } : unknown);
    expect(jobs[0].url).toBe(url); expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].crawledAt).toBeTruthy(); expect(transport).toHaveBeenCalledTimes(1);
  });
}
for (const kind of ['valid', 'missing', 'invalid', 'future', 'foreign-url', 'foreign-sameas', 'ambiguous', 'url-less', 'other-title', 'malformed-url']) {
  it(`Valiant: identified detail publication ${kind}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const raw = kind === 'missing' ? undefined : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : `${year}-06-15T13:00:00+02:00`;
    const url = 'https://jobs.valiant.ch/offene-stellen/fixture/123';
    const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Anderer Beruf' : title, description: body, datePosted: raw, url: ['ambiguous', 'url-less'].includes(kind) ? undefined : kind === 'foreign-url' ? 'https://wrong.example/job' : kind === 'malformed-url' ? 'http://[' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/job' : undefined, jobLocation: { address: { addressLocality: 'Bern', addressCountry: 'CH' } } };
    const detail = `<script type="application/ld+json">${JSON.stringify(posting)}</script>${kind === 'ambiguous' ? `<script type="application/ld+json">${JSON.stringify({ ...posting, datePosted: `${year}-01-01` })}</script>` : ''}`;
    const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : `<a class="job job-123" href="${url}" title="${title}">Details</a>`, { status: 200 }));
    vi.stubGlobal('fetch', transport); const pending = fetchAllValiantBankJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(['valid', 'url-less'].includes(kind) ? { datePosted: raw, postedDate: raw!.slice(0, 10), postingDateSource: 'reported' } : unknown);
    expect(jobs[0].url).toBe(url); expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].crawledAt).toBeTruthy(); expect(transport).toHaveBeenCalledTimes(2);
  });
}
