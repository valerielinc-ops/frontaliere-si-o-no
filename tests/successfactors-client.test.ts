import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitJobs2WebRow,
  detectSuccessFactorsKind,
  extractJobs2WebDeclaredTotal,
  fetchSuccessFactorsJobs,
} from '../scripts/lib/ats-clients/successfactors-client.mjs';

function searchPage(jobId: string, title: string, location = 'Orbe, CH') {
  return `
    <table>
      <tr>
        <td class="colTitle"><a href="/job/Orbe-${jobId}/${jobId}/">${title}</a></td>
        <td class="colFacility"></td>
        <td class="colLocation"><span class="jobLocation">${location}</span></td>
        <td class="colDate"><span class="jobDate">May 23, 2026</span></td>
      </tr>
    </table>
  `;
}

function fullSearchPage(startId: number) {
  return Array.from({ length: 10 }, (_, index) =>
    searchPage(String(startId + index), `Role ${startId + index}`),
  ).join('\n');
}

describe('SuccessFactors client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies Nestlé jobdetails pages as jobs2web SuccessFactors pages', () => {
    expect(detectSuccessFactorsKind('https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland')).toBe('html-jobreq');
    expect(detectSuccessFactorsKind('https://jobdetails.nestle.com/job/Orbe-Test/123/')).toBe('html-jobreq');
  });

  it('paginates server-rendered jobs2web search pages with startrow', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(fullSearchPage(1001), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchPage('1011', 'Second Page Role'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = [];
    for await (const job of fetchSuccessFactorsJobs(
      'https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland',
      { maxPages: 2, minDelayMs: 0, company: 'Nestlé' },
    )) {
      jobs.push(job);
    }

    expect(jobs.map((job) => job.jobReqId)).toEqual([
      '1001', '1002', '1003', '1004', '1005',
      '1006', '1007', '1008', '1009', '1010',
      '1011',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland&startrow=10', expect.any(Object));
  });

  // jobdetails.nestle.com (2026-09-29): "Results 1 – 10 of 110" for the Swiss
  // search, but startrow=5000 and startrow=50000 still return the same full
  // page of unrelated results. The loop only stopped on a short page, so with
  // `maxPages: 100000` a Nestlé crawl never finished.
  it('stops when a page adds no new requisition', async () => {
    const repeated = fullSearchPage(9001);
    const fetchMock = vi.fn(async () => new Response(repeated, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = [];
    for await (const job of fetchSuccessFactorsJobs(
      'https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland',
      { maxPages: 100000, minDelayMs: 0, company: 'Nestlé' },
    )) {
      jobs.push(job);
    }

    expect(jobs).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops once the next offset passes the declared result total', async () => {
    const withTotal = (startId: number) => `<span class="paginationLabel">Results <b>${startId - 1000} – ${startId - 991}</b> of <b>20</b></span>${fullSearchPage(startId)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(withTotal(1001), { status: 200 }))
      .mockResolvedValueOnce(new Response(withTotal(1011), { status: 200 }))
      .mockResolvedValue(new Response(fullSearchPage(5001), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = [];
    for await (const job of fetchSuccessFactorsJobs(
      'https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland',
      { maxPages: 100000, minDelayMs: 0, company: 'Nestlé' },
    )) {
      jobs.push(job);
    }

    expect(jobs.map((job) => job.jobReqId)).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A search row without a requisition id is identified by its URL. Before,
  // every such row counted as new, so a repeated full page of them never
  // reached "no new requisition" and the loop ran until maxPages.
  it('identifies a row without a requisition id by its URL', () => {
    const seen = new Set<string>();
    const page = Array.from({ length: 10 }, (_, index) => ({
      jobReqId: '',
      applyUrl: `https://www.swissre.com/careers/job/role-${index}`,
    }));
    expect(page.filter((row) => admitJobs2WebRow(row, seen))).toHaveLength(10);
    // The same page again adds nothing, so the loop stops after fetching it.
    expect(page.filter((row) => admitJobs2WebRow(row, seen))).toHaveLength(0);
    // A row with neither id nor URL cannot prove it is new.
    expect(admitJobs2WebRow({ jobReqId: '', applyUrl: '' }, seen)).toBe(false);
  });

  it('stops after a repeated full page of cards whose links carry no numeric id', async () => {
    const card = (slug: string) => `
      <li class="JobTeaserList--item">
        <a class="JobTeaser--link" href="/careers/job/${slug}">
          <div class="JobTeaser--title">Role ${slug}</div>
        </a>
      </li>`;
    const repeated = `<ul>${Array.from({ length: 10 }, (_, index) => card(`underwriter-${index}`)).join('')}</ul>`;
    const fetchMock = vi.fn(async () => new Response(repeated, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = [];
    for await (const job of fetchSuccessFactorsJobs(
      'https://www.swissre.com/careers/jobSearch.html',
      { maxPages: 100000, minDelayMs: 0, company: 'Swiss Re' },
    )) {
      jobs.push(job);
    }

    expect(jobs).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads the declared total in the tenant languages', () => {
    expect(extractJobs2WebDeclaredTotal('Results <b>1 – 10</b> of <b>110</b>')).toBe(110);
    expect(extractJobs2WebDeclaredTotal('Ergebnisse <b>1 – 25</b> von <b>1,093</b>')).toBe(1093);
    expect(extractJobs2WebDeclaredTotal('<p>no counter</p>')).toBeNull();
  });

  it('classifies the Swiss Re CSB "JobTeaserList" career page as html-jobreq (#3797)', () => {
    expect(detectSuccessFactorsKind('https://www.swissre.com/careers/jobSearch.html')).toBe('html-jobreq');
    expect(detectSuccessFactorsKind('https://www.swissre.com/careers/job/underwriting-manager/700123')).toBe('html-jobreq');
  });

  it('falls back to JobTeaserList card scraping when the jobs2web table-row parser finds nothing (#3797)', async () => {
    const cardHtml = `
      <ul>
        <li class="JobTeaserList--item">
          <div class="JobTeaser--title">Underwriting Manager</div>
          <div class="JobTeaser--location"><span>Zurich, CH</span></div>
          <a class="JobTeaser--link" href="/careers/job/underwriting-manager/700123">View</a>
        </li>
      </ul>
    `;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(cardHtml, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = [];
    for await (const job of fetchSuccessFactorsJobs(
      'https://www.swissre.com/careers/jobSearch.html',
      { maxPages: 1, minDelayMs: 0, company: 'Swiss Re' },
    )) {
      jobs.push(job);
    }

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobReqId: '700123',
      title: 'Underwriting Manager',
      location: 'Zurich, CH',
      applyUrl: 'https://www.swissre.com/careers/job/underwriting-manager/700123',
    });
  });
});
