import { describe, expect, it, vi } from 'vitest';
import {
  buildAristonLocalizedContent,
  inferAristonRegion,
  isAristonTargetLocation,
  parseAristonJobDetail,
  parseAristonSitemapFeed,
} from '../scripts/lib/ariston-job-parser.mjs';

describe('ariston job parser', () => {
  const validFeedItem = ({
    title = '<title>Service Technician (Bedano, CH, 6930)</title>',
    link = '<link>https://careers.aristongroup.com/job/Bedano-Service-Technician/123/</link>',
    location = '<g:location>Bedano, CH, 6930</g:location>',
    employer = '<g:employer>Ariston Group</g:employer>',
    category = '<g:job_function>Service</g:job_function>',
    validThrough = '<g:expiration_date>2026-12-31</g:expiration_date>',
  } = {}) => `<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item>${title}${link}${location}${employer}${category}${validThrough}</item></channel></rss>`;

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

  it('requires the authoritative CH country marker before fuzzy Swiss matching', () => {
    expect(isAristonTargetLocation('Bedano, CH, 6930')).toBe(true);
    expect(isAristonTargetLocation('Fontaines, CH, 2046 TECHNICIEN RÉGION NEUCHÂTEL')).toBe(true);
    expect(isAristonTargetLocation('Hannover, Dresden, Frankfurt, Koblenz, DE, x')).toBe(false);
    expect(isAristonTargetLocation('Mainburg, DE, 84048 RAUM KOBLENZ')).toBe(false);
    expect(isAristonTargetLocation('Bedano, 6930')).toBe(false);
    expect(inferAristonRegion('Fontaines, CH, 2046 TECHNICIEN RÉGION NEUCHÂTEL').canton).toBe('NE');
  });

  it('throws a clear, low-drama error instead of the opaque fast-xml-parser exception on unparseable input (#4246)', () => {
    // Reproduces the shape Jina's `X-Return-Format: html` fallback returns when
    // careers.aristongroup.com's RSS/XML feed can't be reached directly from the
    // CI runner: each of the ~180 RSS <item>s becomes an HTML <div> containing an
    // unclosed void element (<br>), which never pops off fast-xml-parser's strict
    // tag stack and blows past maxNestedTags (default 100) partway through.
    const unclosedBrPerItem = Array.from(
      { length: 120 },
      (_, i) => `<div><h3><a href="https://careers.aristongroup.com/job/${i}/">Job ${i}</a></h3><br></div>`,
    ).join('');
    const jinaHtmlFallback = `<html><head><title>Careers</title></head><body>${unclosedBrPerItem}</body></html>`;
    expect(() => parseAristonSitemapFeed(jinaHtmlFallback)).toThrow(
      /Ariston sitemap feed failed to parse as XML/,
    );
    // The library's own opaque message must NOT be the only signal — it should be
    // wrapped, not swallowed (still present in the cause, just not the whole story).
    expect(() => parseAristonSitemapFeed(jinaHtmlFallback)).not.toThrow(/^Maximum nested tags exceeded$/);
  });

  it.each([
    '<rss><channel><item><title>Service</title></description></item></channel></rss>',
    '<rss><channel><item><title>Service</title></item>',
  ])('rejects malformed or truncated feed XML before parsing', (xml) => {
    expect(() => parseAristonSitemapFeed(xml)).toThrow(/failed to parse as XML/);
  });

  it.each([
    ['title', { title: '<title><strong>Service Technician</strong></title>' }],
    ['link', { link: '<link>https://careers.aristongroup.com/job/1/</link><link>https://careers.aristongroup.com/job/2/</link>' }],
    ['g:location', { location: '<g:location>Bedano</g:location><g:location>Lugano</g:location>' }],
    ['g:employer', { employer: '<g:employer><strong>Ariston</strong></g:employer>' }],
    ['g:job_function', { category: '<g:job_function>Service</g:job_function><g:job_function>Sales</g:job_function>' }],
    ['g:expiration_date', { validThrough: '<g:expiration_date>2026-12-31</g:expiration_date><g:expiration_date>2027-01-31</g:expiration_date>' }],
  ])('drops a single item with a non-scalar or repeated %s leaf instead of aborting the whole feed', (field, override) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAristonSitemapFeed(validFeedItem(override))).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} must be a single scalar string`),
      ),
    );
    warnSpy.mockRestore();
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
