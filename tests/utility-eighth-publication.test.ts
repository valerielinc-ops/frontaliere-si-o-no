import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllPostAutoJobs } from '../scripts/lib/postauto-job-parser.mjs';
import { fetchAllProtectasJobs } from '../scripts/lib/protectas-job-parser.mjs';
import { fetchAllRebootMonkeyJobs } from '../scripts/lib/reboot-monkey-job-parser.mjs';

const body = 'La persona garantisce la sorveglianza fisica dei siti dei clienti nel Luganese. Effettua ronde diurne e notturne, controlla gli accessi e segnala ogni evento al superiore. '.repeat(5);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const publication = (kind: string) => {
  const year = new Date().getUTCFullYear() - 1;
  return kind === 'missing' ? undefined : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : `${year}-06-15T13:00:00+02:00`;
};
for (const kind of ['valid', 'missing', 'invalid', 'future']) {
  it(`PostAuto propagates validated detail publication: ${kind}`, async () => {
    const raw = publication(kind);
    const record = { id: '74240', unifiedUrlTitle: 'Chauffeur', brandUrl: 'default', cust_brandCompanyJobSearch: ['PostAuto'], supportedLocales: ['de_DE'] };
    const posting = { '@type': 'JobPosting', title: 'Chauffeur Bus', description: body, datePosted: raw, jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH' } } };
    const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input).includes('/services/') ? JSON.stringify({ totalJobs: 1, jobSearchResult: [{ response: record }] }) : `<script type="application/ld+json">${JSON.stringify(posting)}</script>`, { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const pending = fetchAllPostAutoJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : unknown);
    expect(jobs[0].description).toContain('sorveglianza fisica'); expect(jobs[0].crawledAt).toBeTruthy();
    expect(jobs[0].url).toBe('https://job.post.ch/default/job/Chauffeur/74240-de_DE');
    expect(transport).toHaveBeenCalledTimes(5);
  });
}
for (const kind of ['valid', 'missing', 'invalid', 'future', 'foreign-url', 'foreign-sameas', 'ambiguous', 'url-less', 'micro-only', 'invalid-json-valid-micro', 'unscoped-micro', 'multiple-micro', 'foreign-url-valid-micro', 'foreign-itemid', 'nested-article']) {
  it(`Protectas validates each publication candidate and vacancy identity: ${kind}`, async () => {
    const url = 'https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/744000150722610/';
    const title = 'Agente di sicurezza ausiliario';
    const raw = publication(kind === 'invalid-json-valid-micro' ? 'invalid' : kind);
    const posting = { '@type': 'JobPosting', title, description: body, datePosted: ['micro-only', 'unscoped-micro', 'multiple-micro', 'foreign-url-valid-micro', 'foreign-itemid', 'nested-article'].includes(kind) ? undefined : raw, url: ['ambiguous', 'url-less'].includes(kind) ? undefined : ['foreign-url', 'foreign-url-valid-micro'].includes(kind) ? 'https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/744000150722999/' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/job' : undefined, jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'Ticino', addressCountry: 'CH' } } };
    const date = `<time itemprop="datePosted" datetime="${publication('valid')}">Publication</time>`;
    const scope = `<div itemscope itemtype="https://schema.org/JobPosting" ${kind === 'foreign-itemid' ? 'itemid="https://wrong.example/job"' : ''}><h1>${title}</h1>${kind === 'nested-article' ? `<div itemscope itemtype="https://schema.org/Article">${date}</div>` : date}</div>`;
    const detail = `<h1>${title}</h1><script type="application/ld+json">${JSON.stringify(posting)}</script>${kind === 'ambiguous' ? `<script type="application/ld+json">${JSON.stringify({ ...posting, datePosted: publication('valid') })}</script>` : ''}${['micro-only', 'invalid-json-valid-micro', 'foreign-url-valid-micro', 'foreign-itemid', 'nested-article'].includes(kind) ? scope : kind === 'multiple-micro' ? scope + scope : kind === 'unscoped-micro' ? date : ''}`;
    const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : `<a href="${url}">Vacancy</a>`, { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const pending = fetchAllProtectasJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    const accepted = ['valid', 'url-less', 'micro-only', 'invalid-json-valid-micro'].includes(kind);
    expect(jobs[0]).toMatchObject(accepted ? { datePosted: publication('valid'), postedDate: publication('valid'), postingDateSource: 'reported' } : unknown);
    expect(jobs[0].description).toContain('sorveglianza fisica'); expect(jobs[0].crawledAt).toBeTruthy();
    expect(jobs[0].url).toBe(['foreign-url', 'foreign-url-valid-micro'].includes(kind) ? 'https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/744000150722999/' : url);
    expect(transport).toHaveBeenCalledTimes(2);
  });
}
for (const kind of ['valid', 'missing', 'invalid', 'future']) {
  it(`Reboot Monkey never equates creation with publication: ${kind}`, async () => {
    const url = 'https://www.rebootmonkey.com/en/jobs/technician';
    const row = { id: 'fixture', title: 'Data Center Technician', city: 'Lugano', country_code: 'CH', description: body, url, created_at: publication(kind) };
    const transport = vi.fn(async () => new Response(JSON.stringify({ total: 1, count: 1, pages: 1, results: [row] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const pending = fetchAllRebootMonkeyJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ ...unknown, url });
    expect(jobs[0].description).toContain('sorveglianza fisica'); expect(jobs[0].crawledAt).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(1);
  });
}
