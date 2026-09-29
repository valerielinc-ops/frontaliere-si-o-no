import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuccessFactorsParser } from '../scripts/lib/successfactors-shared-job-parser-common.mjs';

// Only the posting's own text is published (issue 5253). A CSB detail page
// without a vacancy body used to be published with an invented brand summary
// ("{title} bei {company} in {city}. … Diese Stelle bietet ein modernes
// Arbeitsumfeld …"); on main (2026-09-29) that happened on 1 row over the 14
// tenants of the shared factory (helsana 1/54). Such a listing is not
// published any more.
const BODY = `
  <p>Join our operations team and help us build reliable products for customers.</p>
  <p>Your responsibilities include planning, delivery, quality, documentation,
  stakeholder management, continuous improvement, teamwork, communication,
  analysis, reporting, compliance and customer support in Männedorf.</p>
`;

function detailHtml(body: string) {
  return `<!doctype html>
    <html lang="en">
      <body itemscope itemtype="https://schema.org/JobPosting">
        <div data-careersite-propertyid="description">${body}</div>
        <span data-careersite-propertyid="city">Männedorf</span>
        <meta itemprop="datePosted" content="2026-09-27T00:00:00Z">
      </body>
    </html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSuccessFactorsParser — listing without a vacancy body', () => {
  it('publishes the posting with a body and drops the one without, never inventing text', async () => {
    const searchHtml = `<!doctype html><table>
      <tr><td><a href="/job/technical-writer/123/">Technical Writer</a></td><td class="colLocation hidden-phone">Männedorf, ZH, CH</td></tr>
      <tr><td><a href="/job/lab-assistant/456/">Lab Assistant</a></td><td class="colLocation hidden-phone">Männedorf, ZH, CH</td></tr>
    </table>`;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => ({
      ok: true,
      status: 200,
      text: async () => {
        if (rawUrl.includes('/search/')) return searchHtml;
        if (rawUrl.includes('/123/')) return detailHtml(BODY);
        return detailHtml('<p>Jetzt bewerben</p>');
      },
    })));

    const parser = createSuccessFactorsParser({
      companyKey: 'no-body-test',
      companyName: 'Example AG',
      companyDomain: 'example.ch',
      sfCompanyId: 'example',
      publicCareerUrl: 'https://careers.example.ch',
      defaultCanton: 'ZH',
      defaultCity: 'Männedorf',
      defaultPostalCode: '8708',
      defaultSourceLang: 'en',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Technical Writer');
    expect(jobs[0].description).toContain('Join our operations team');
    for (const job of jobs) {
      expect(job.description).not.toMatch(/Diese Stelle bietet ein modernes Arbeitsumfeld/);
    }
  });
});
