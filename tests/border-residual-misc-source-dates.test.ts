import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkdayJobDetail } from '../scripts/lib/julius-baer-job-parser.mjs';
import { parseSmartRecruitersDetail } from '../scripts/lib/lastminute-job-parser.mjs';
import { buildLastminuteSourceJob, syncLastminutePublication } from '../scripts/update-lastminute-jobs.mjs';
import { buildJobFromDetail, fetchJobDetails } from '../scripts/update-grace-jobs.mjs';
import { fetchIstJobs } from '../scripts/update-ist-jobs.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
vi.mock('../scripts/lib/crawler-template.mjs', async (original) => ({
  ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(),
  fetchHtml: vi.fn(),
}));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({ launchChromium: vi.fn() }));
import { launchChromium } from '../scripts/lib/ensure-chromium.mjs';
import { JSDOM } from 'jsdom';
import { fetchHtml } from '../scripts/lib/crawler-template.mjs';
const body = 'We are seeking an experienced teacher who will support students in their learning and development through carefully planned lessons and collaborative activities. '.repeat(5);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const stamp = '2020-06-05T12:30:00+02:00';
const reported = { datePosted: stamp, postedDate: stamp.slice(0, 10), postingDateSource: 'reported' };
const reportedFull = { datePosted: stamp, postedDate: stamp, postingDateSource: 'reported' };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Julius Baer Workday source dates', () => {
  it.each([undefined, '', '2020-02-30', '2099-01-01', '2020-06-05garbage', 'Posted Yesterday'])('rejects absent or invalid publication %s', (startDate) => {
    expect(parseWorkdayJobDetail({ jobPostingInfo: { title: 'Relationship Manager', location: 'CHE - Lugano', startDate } }, '/job/role_REQ123')).toMatchObject(unknown);
  });
  it('preserves the full source instant and its provenance', () => {
    expect(parseWorkdayJobDetail({ jobPostingInfo: { title: 'Relationship Manager', location: 'CHE - Lugano', startDate: stamp } }, '/job/role_REQ123')).toMatchObject(reportedFull);
  });
});

describe('Lastminute releasedDate transport and recrawl', () => {
  it.each([undefined, '', '2020-02-30', '2099-01-01', '2020-06-05Tbad', 1580000000000])('does not salvage a date prefix from %s', (releasedDate) => {
    const parsed = parseSmartRecruitersDetail({ name: 'Engineer', releasedDate });
    expect(parsed).toMatchObject(unknown);
    expect(buildLastminuteSourceJob({ ...parsed, description: body, location: 'Chiasso' }, 'https://careers.lastminute.com/job/123')).toMatchObject(unknown);
  });
  it('retains the complete timestamp through parser and source builder', () => {
    const parsed = parseSmartRecruitersDetail({ name: 'Engineer', releasedDate: stamp });
    expect(buildLastminuteSourceJob({ ...parsed, description: body, location: 'Chiasso' }, 'https://careers.lastminute.com/job/123')).toMatchObject(reported);
  });
  it('removes a legacy invented date and preserves verified evidence on later unknown recrawl', () => {
    const existing = { postedDate: '2020-01-01', url: 'https://careers.lastminute.com/job/123' };
    expect(syncLastminutePublication(existing, unknown)).toBe(true);
    expect(existing).toMatchObject(unknown);
    syncLastminutePublication(existing, reported);
    syncLastminutePublication(existing, unknown);
    expect(existing).toMatchObject(reported);
  });
});

describe('Grace bounded publication label', () => {
  const listing = { title: 'Receptionist', href: 'https://www.hotelcareer.com/jobs/grace-120155/receptionist-3694182' };
  it.each(['06/05/2020', 'Updated: 06/05/2020', 'Posted: 06/05/2020suffix', 'Posted: 06/05/20200', 'Posted: 02/30/2020', 'Posted: 06/05/2099', ''])('rejects unlabelled, malformed or future value %s', (postedRaw) => {
    expect(buildJobFromDetail(listing, { postedRaw, description: body })).toMatchObject(unknown);
  });
  it('accepts a complete explicit publication label', () => {
    expect(buildJobFromDetail(listing, { postedRaw: 'Posted on: 06/05/2020', description: body })).toMatchObject({ datePosted: '2020-06-05', postedDate: '2020-06-05', postingDateSource: 'reported' });
  });
});

describe('IST live fetch projection and production merge', () => {
  it.each([undefined, '2020-02-30', '2099-01-01', '2020-06-05garbage', stamp])('transports strict publication %s without throwing', async (date) => {
    const url = 'https://jobs.inspirededu.com/job/international-school-of-ticino/123456/';
    vi.mocked(fetchHtml).mockImplementation(async (input) => String(input).endsWith('sitemap.xml')
      ? `<urlset><url><loc>${url}</loc></url></urlset>`
      : `<meta itemprop="title" content="English Teacher"><meta itemprop="streetAddress" content="Lugano, CH"><meta itemprop="company" content="International School of Ticino">${date ? `<meta itemprop="datePosted" content="${date}">` : ''}<span data-careersite-propertyid="description">${body}</span>`);
    const jobs = await fetchIstJobs();
    expect(jobs).toHaveLength(1);
    const expected = date === stamp ? reported : unknown;
    expect(jobs[0]).toMatchObject(expected);
    const merged = mergePreserveLocaleData([{ ...jobs[0], datePosted: '2020-01-01', postedDate: '2020-01-01', postingDateSource: undefined }], jobs);
    expect(merged[0]).toMatchObject(date === stamp ? reportedFull : unknown);
  });
});


describe('Grace actual browser callbacks replayed against DOM', () => {
  it.each([
    ['own-container', '<nav><span class="date">Posted: 01/01/2021</span></nav><div id="jobDesignerContainer"><h1>Receptionist</h1><span class="date">Posted: 06/05/2020</span></div>', '2020-06-05'],
    ['foreign-page-title', '<div id="jobDesignerContainer"><h1>Chef</h1><span class="date">Posted: 06/05/2020</span></div>', ''],
    ['related-title', '<h1>Receptionist</h1><div class="job_container"><h2 class="job-title">Chef</h2><span class="date">Posted: 06/05/2020</span></div>', ''],
    ['multiple-containers', '<div id="jobDesignerContainer"><h1>Receptionist</h1><span class="date">Posted: 06/05/2020</span></div><div class="job_container"><h2 class="job-title">Chef</h2><span class="date">Posted: 01/01/2021</span></div>', ''],
    ['navigation-only', '<nav><span class="date">Posted: 06/05/2020</span></nav><div id="jobDesignerContainer"><h1>Receptionist</h1></div>', ''],
    ['multiple-dates', '<div id="jobDesignerContainer"><h1>Receptionist</h1><span class="date">Posted: 06/05/2020</span><span class="date">Posted: 01/01/2021</span></div>', ''],
  ])('isolates %s from other page dates', async (_name, html, expectedDate) => {
    const dom = new JSDOM(`<html><body>${html}<section id="tasks">${body}</section></body></html>`);
    vi.stubGlobal('document', dom.window.document);
    const evaluate = vi.fn(async (callback: (arg?: string) => unknown, arg?: string) => callback(arg));
    const close = vi.fn(async () => {});
    const page = {
      goto: vi.fn(async () => ({})), waitForTimeout: vi.fn(async () => {}),
      title: vi.fn(async () => 'Receptionist | Grace'), waitForSelector: vi.fn(async () => {}),
      locator: () => ({ textContent: async () => dom.window.document.body.textContent }),
      frames: () => [], evaluate, close,
    };
    type GraceBrowserBoundary = {
      newContext: () => Promise<{ newPage: () => Promise<typeof page> }>;
      close: () => Promise<void>;
    };
    const browser = { newContext: async () => ({ newPage: async () => page }), close } satisfies GraceBrowserBoundary;
    // Only the browser methods consumed by fetchJobDetails are mocked; callbacks run unchanged on DOM.
    vi.mocked(launchChromium).mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof launchChromium>>);
    try {
      const jobs = await fetchJobDetails([{ title: 'Receptionist', href: 'https://www.hotelcareer.com/jobs/grace-120155/receptionist-3694182' }]);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: expectedDate, postedDate: expectedDate ? expectedDate.slice(0, 10) : '', postingDateSource: expectedDate ? 'reported' : 'unknown' });
      expect(jobs[0].description).toContain('experienced teacher');
    } finally { dom.window.close(); }
  });
});
