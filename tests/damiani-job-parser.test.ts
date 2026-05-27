import { describe, expect, it } from 'vitest';
import {
  isDamianiTicinoLocation,
  parseDamianiSearchPage,
  parseDamianiJobDetail,
  buildDamianiLocalizedContent,
} from '../scripts/lib/damiani-job-parser.mjs';

describe('damiani-job-parser', () => {
  it('keeps only Ticino locations', () => {
    expect(isDamianiTicinoLocation('Mendrisio')).toBe(true);
    expect(isDamianiTicinoLocation('Lugano')).toBe(true);
    expect(isDamianiTicinoLocation('Milano')).toBe(false);
  });

  it('parses search rows', () => {
    const html = `
      <table id="searchresults">
        <tr class="data-row">
          <td class="colTitle"><a href="/job/Mendrisio-Treasury-Specialist/1327326955/" class="jobTitle-link">Treasury Specialist</a></td>
          <td class="colLocation"><span class="jobLocation">Mendrisio</span></td>
          <td class="colDate"><span class="jobDate">9 mar 2026</span></td>
        </tr>
      </table>
    `;
    const rows = parseDamianiSearchPage(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBe('Mendrisio');
    expect(rows[0].title).toBe('Treasury Specialist');
  });

  it('parses detail content and localizes slugs', () => {
    const html = `
      <span itemprop="title">Treasury Specialist</span>
      <p id="job-location"><span class="jobGeoLocation">Mendrisio</span></p>
      <meta itemprop="datePosted" content="Mon Mar 09 02:00:00 UTC 2026">
      <a class="apply dialogApplyBtn" href="/talentcommunity/apply/1327326955/?locale=en_US">Apply now</a>
      <span class="jobdescription">
        <h3>Missione del ruolo</h3>
        <p>Gestione tesoreria di gruppo.</p>
        <h3>Requisiti</h3>
        <ul><li>Esperienza 3-5 anni</li></ul>
      </span>
    `;
    const detail = parseDamianiJobDetail(html);
    const localized = buildDamianiLocalizedContent(detail);
    expect(detail.location).toBe('Mendrisio');
    expect(detail.description).toContain('## Missione del ruolo');
    expect(localized.titleByLocale.it).toBe('Specialista Tesoreria');
    expect(localized.slugByLocale.it).toContain('specialista-tesoreria');
  });
});
