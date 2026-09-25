import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectSuccessFactorsKind,
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
