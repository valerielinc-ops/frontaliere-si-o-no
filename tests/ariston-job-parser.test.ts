import { describe, expect, it } from 'vitest';
import {
  buildAristonLocalizedContent,
  inferAristonRegion,
  isAristonTargetLocation,
  parseAristonJobDetail,
  parseAristonSitemapFeed,
} from '../scripts/lib/ariston-job-parser.mjs';

describe('ariston job parser', () => {
  it('parses sitemap feed items and keeps target locations', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
        <channel>
          <item>
            <title>COLLABORATORE/TRICE SERVICE CENTER 80% (Bedano, CH, 6930)</title>
            <link>https://careers.aristongroup.com/job/Maerstetten-COLLABORATORETRICE-SERVICE-CENTER-80-Beda-6930/1367135733/</link>
            <g:location>Bedano, CH, 6930</g:location>
            <g:expiration_date>2026-04-09</g:expiration_date>
          </item>
        </channel>
      </rss>`;
    const items = parseAristonSitemapFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].location).toContain('Bedano');
    expect(isAristonTargetLocation(items[0].location)).toBe(true);
  });

  it('parses detail page metadata and description', () => {
    const html = `
      <html><head>
        <meta itemprop="datePosted" content="Tue Feb 24 00:00:00 UTC 2026">
      </head><body>
        <a class="apply dialogApplyBtn" href="/talentcommunity/apply/1367135733/?locale=en_US">Apply now</a>
        <p id="job-location" class="jobLocation"><span class="jobGeoLocation">Bedano, CH, 6930</span></p>
        <div class="job"><div class="title">COLLABORATORE/TRICE SERVICE CENTER 80%</div></div>
        <span class="jobdescription">
          <p>ELCO cerca una figura per il service center di Bedano.</p>
          <p>Supporto clienti e coordinamento interventi.</p>
        </span>
      </body></html>`;
    const detail = parseAristonJobDetail(html);
    expect(detail.title).toContain('SERVICE CENTER');
    expect(detail.location).toContain('Bedano');
    expect(detail.description).toContain('ELCO');
    expect(detail.applyHref).toContain('/talentcommunity/apply/1367135733/');
    expect(inferAristonRegion(detail.location).canton).toBe('TI');
  });

  it('builds localized slugs anchored to Ariston Group and location', () => {
    const localized = buildAristonLocalizedContent({
      title: 'COLLABORATORE/TRICE SERVICE CENTER 80%',
      location: 'Bedano, CH, 6930',
      description: 'Testo prova',
    });
    expect(localized.slugByLocale.it).toContain('ariston-group');
    expect(localized.slugByLocale.it).toContain('bedano');
  });
});
