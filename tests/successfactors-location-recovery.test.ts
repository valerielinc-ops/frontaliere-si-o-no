import { describe, expect, it, vi } from 'vitest';

import {
  createSuccessFactorsParser,
  parseCsbDetailPage,
} from '../scripts/lib/successfactors-shared-job-parser-common.mjs';

const DETAIL_DESCRIPTION = `
  <p>Join our operations team and help us build reliable products for customers.</p>
  <p>Männedorf, Zürich</p>
  <p>Your responsibilities include planning, delivery, quality, documentation,
  stakeholder management, continuous improvement, teamwork, communication,
  analysis, reporting, compliance and customer support.</p>
  <p>You bring a completed technical education, several years of experience
  and good German and English skills, and you enjoy working in a small team.</p>
`;

function detailHtml(country = 'Sw') {
  return `<!doctype html>
    <html lang="en">
      <body itemscope itemtype="https://schema.org/JobPosting">
        <div data-careersite-propertyid="description">${DETAIL_DESCRIPTION}</div>
        <span data-careersite-propertyid="city"></span>
        <span data-careersite-propertyid="country">${country}</span>
        <meta itemprop="datePosted" content="2026-09-27T00:00:00Z">
      </body>
    </html>`;
}

describe('SuccessFactors location recovery', () => {
  it('recovers a source-backed city from the description when CSB city is blank', () => {
    const detail = parseCsbDetailPage(detailHtml());

    expect(detail?.city).toBe('Männedorf');
    expect(detail?.location).toBe('Männedorf');
  });

  it('accepts the Tecan country token only with Swiss listing evidence', async () => {
    const searchHtml = `<!doctype html><table>
      <tr>
        <td><a href="/job/technical-writer/123/">Technical Writer</a></td>
        <td class="colLocation hidden-phone">Switzerland</td>
      </tr>
    </table>`;
    const fetchMock = vi.fn(async (rawUrl: string) => ({
      ok: true,
      status: 200,
      text: async () => rawUrl.includes('/search/') ? searchHtml : detailHtml(),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const parser = createSuccessFactorsParser({
      companyKey: 'tecan-test',
      companyName: 'Tecan',
      companyDomain: 'tecan.com',
      sfCompanyId: 'tecan',
      publicCareerUrl: 'https://careers.tecan.com',
      defaultCanton: 'ZH',
      defaultCity: 'Männedorf',
      defaultPostalCode: '8708',
      defaultSourceLang: 'en',
      sector: 'Tecnologia / Strumentazione di laboratorio',
      fallbackCategory: 'Tecnica',
      searchParams: { locationsearch: 'Switzerland' },
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Männedorf', canton: 'ZH' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
