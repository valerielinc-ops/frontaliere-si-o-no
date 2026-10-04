import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllEmmiJobs } from '../scripts/lib/emmi-job-parser.mjs';
import { fetchAllVzVermoegenszentrumJobs } from '../scripts/lib/vz-vermoegenszentrum-job-parser.mjs';
import { fetchAllHermesJobs } from '../scripts/lib/hermes-job-parser.mjs';
import { fetchAllStraumannJobs } from '../scripts/lib/straumann-job-parser.mjs';
import { fetchAllBadruttsPalaceJobs } from '../scripts/lib/badrutts-palace-job-parser.mjs';
import { buildJob as buildCerbios } from '../scripts/lib/cerbios-pharma-job-parser.mjs';
import { buildJob as buildLugano } from '../scripts/lib/citta-di-lugano-job-parser.mjs';
import { buildJob as buildEms } from '../scripts/lib/ems-chemie-job-parser.mjs';
import { sourceRssPostingDateFields } from '../scripts/lib/source-posting-date.mjs';

const state = vi.hoisted(() => ({ publication: '', modified: '', body: 'We are looking for a qualified professional to join our team and support reliable services for our customers. You will work closely with colleagues across departments, document your work carefully and contribute practical ideas to improve our processes. The role requires relevant professional experience, strong communication skills and a structured approach to solving problems. We offer a collaborative workplace, continuing education and opportunities to take responsibility for meaningful projects.' }));
vi.mock('../scripts/lib/crawler-template.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  fetchHtml: async () => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: state.body })}</script>`,
  fetchJson: async (url: string) => {
    if (url.includes('ohws.prospective.ch')) return { total: 1, jobs: [{ id: '12345', title: 'Operations Specialist', start_date: state.publication, last_modification_timestamp: state.modified, szas: { 'sza_location.country': 'Schweiz', 'sza_location.city': 'Zug', 'sza_location.zip': '6300', sza_tasks: `<p>${state.body}</p>`, sza_requirements: state.body }, links: { directlink: url.includes('1003228') ? 'https://jobs.emmi.com/offene-stellen/operations-specialist/12345' : 'https://jobs.vermoegenszentrum.ch/offene-stellen/operations-specialist/12345' } }] };
    if (url.includes('recruitingCEJobRequisitionDetails')) return { items: [{ ExternalDescriptionStr: state.body }] };
    if (url.includes('recruitingCEJobRequisitions')) return { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '12345', Title: 'Operations Specialist', PrimaryLocation: 'Zurich, Switzerland', PrimaryLocationCountry: 'CH', PostedDate: state.publication }] }] };
    throw new Error(`Unexpected JSON endpoint ${url}`);
  },
}));
vi.mock('../scripts/lib/pastahr-widget-client.mjs', () => ({
  fetchPostWidgetWithAntiBotHardening: async () => ({ refineSearch: { data: { jobs: [{ reqId: '12345', jobId: '12345', title: 'Operations Specialist', country: 'Switzerland', city: 'Basel', postedDate: state.publication, descriptionTeaser: state.body }] } } }),
}));

beforeEach(() => {
  state.publication = '';
  state.modified = new Date(Date.now() - 86400000).toISOString();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0; }) as unknown as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = new Response(`<rss><channel><item><title>Operations Specialist</title><link>https://jobs.badruttscareers.com/en-GB/jobs/12345-operations-specialist</link><description><![CDATA[${state.body}]]></description><pubDate>${state.publication}</pubDate></item></channel></rss>`, { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://jobs.badruttscareers.com/en-GB/jobs.rss' });
    return response;
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const [name, fetchJobs] of [
  ['Emmi', fetchAllEmmiJobs], ['VZ', fetchAllVzVermoegenszentrumJobs], ['Hermes', fetchAllHermesJobs], ['Straumann', fetchAllStraumannJobs], ['Badrutts', fetchAllBadruttsPalaceJobs],
] as const) {
  describe(`${name} real producer provenance`, () => {
    it('keeps a missing publication unknown even when a modification timestamp exists', async () => {
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
    it('preserves an exact source timestamp and its marker', async () => {
      state.publication = new Date(Date.now() - 7 * 86400000).toISOString();
      if (name === 'Badrutts') state.publication = new Date(state.publication).toUTCString();
      const expected = name === 'Badrutts' ? sourceRssPostingDateFields(state.publication).datePosted : state.publication;
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: 'reported' });
    });
    it('rejects impossible source dates instead of substituting crawl time', async () => {
      state.publication = '2025-02-30';
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
  });
}
for (const [name, build] of [['Cerbios', buildCerbios], ['Lugano', buildLugano], ['EMS', buildEms]] as const) {
  describe(`${name} builder provenance`, () => {
    it.each(['', '2025-02-30'])('does not invent publication for %j', datePosted => {
      const job = build({ title: 'Operations Specialist', url: 'https://example.com/job/12345/', location: 'Lugano', description: state.body, datePosted });
      expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
    it('carries an authentic source date with explicit provenance', () => {
      const datePosted = new Date(Date.now() - 7 * 86400000).toISOString();
      const job = build({ title: 'Operations Specialist', url: 'https://example.com/job/12345/', location: 'Lugano', description: state.body, datePosted });
      expect(job).toMatchObject({ datePosted, postedDate: datePosted, postingDateSource: 'reported' });
    });
  });
}
