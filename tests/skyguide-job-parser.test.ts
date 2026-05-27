import { describe, expect, it } from 'vitest';
import {
  parseSkyguideListings,
  isSkyguideTargetLocation,
  parseSkyguideJobDetail,
  buildSkyguideLocalizedContent,
} from '../scripts/lib/skyguide-job-parser.mjs';

describe('skyguide-job-parser', () => {
  it('parses search results for Locarno and Lugano Agno', () => {
    const html = `
      <table id="searchresults">
        <tr class="data-row">
          <td class="colTitle"><a href="/job/Locarno-Formazione-controllorea-del-traffico-aereo-Locarno/1140799801/" class="jobTitle-link">Formazione controllore/a del traffico aereo - Locarno</a></td>
          <td class="colLocation"><span class="jobLocation">Locarno, CH</span></td>
          <td class="colDepartment"><span class="jobDepartment">Operations</span></td>
        </tr>
        <tr class="data-row">
          <td class="colTitle"><a href="/job/Lugano-Agno-Formazione-controllorea-del-traffico-aereo-Lugano/1140799301/" class="jobTitle-link">Formazione controllore/a del traffico aereo - Lugano</a></td>
          <td class="colLocation"><span class="jobLocation">Lugano Agno, CH</span></td>
          <td class="colDepartment"><span class="jobDepartment">Operations</span></td>
        </tr>
      </table>
    `;
    const rows = parseSkyguideListings(html);
    expect(rows).toHaveLength(2);
    expect(isSkyguideTargetLocation(rows[0].location)).toBe(true);
    expect(isSkyguideTargetLocation(rows[1].location)).toBe(true);
  });

  it('parses detail content and builds localized payload', () => {
    const html = `
      <div class="jobDisplayShell">
        <meta itemprop="datePosted" content="Tue Feb 24 02:00:00 UTC 2026">
        <span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
          <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
            <meta itemprop="streetAddress" content="Locarno, CH">
          </span>
        </span>
        <div class="customPlugin"><div class="inner"><p>Skyguide provides air navigation services in Switzerland.</p></div></div>
        <span itemprop="title">Formazione controllore/a del traffico aereo - Locarno</span>
        <span class="jobdescription">
          <div>
            <h2><b>Descrizione:</b></h2>
            <p>Vorresti lavorare in un ambiente dinamico e internazionale?</p>
            <p><strong>Requisiti:</strong></p>
            <ul><li>Ottime conoscenze della lingua italiana</li></ul>
          </div>
        </span>
        <a class="apply dialogApplyBtn" href="/talentcommunity/apply/1140799801/?locale=en_US">Apply now »</a>
      </div>
    `;
    const detail = parseSkyguideJobDetail(html);
    expect(detail.title).toBe('Formazione controllore/a del traffico aereo - Locarno');
    expect(detail.location).toBe('Locarno, CH');
    expect(detail.applyPath).toContain('/talentcommunity/apply/1140799801/');
    expect(detail.description).toContain('Skyguide provides air navigation services in Switzerland.');
    expect(detail.description).toContain('## Descrizione');
    expect(detail.description).toContain('Ottime conoscenze della lingua italiana');

    const localized = buildSkyguideLocalizedContent(detail);
    expect(localized.titleByLocale.it).toBe(detail.title);
    expect(localized.descriptionByLocale.it).toContain('## Descrizione');
    expect(localized.slugByLocale.it).toContain('formazione-controllore-a-del-traffico-aereo-locarno-skyguide-locarno-ch');
  });
});
