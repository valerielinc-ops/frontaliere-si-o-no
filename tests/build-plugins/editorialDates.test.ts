import { describe, expect, it } from 'vitest';
import { editorialModifiedDate, synchronizeSitemapLastmods } from '../../build-plugins/shared/editorialDates';
import { renderBorderDashboardLink } from '../../build-plugins/shared/borderDashboardLink';
import { buildRootHubPath, BORDER_WAIT_LOCALES } from '../../build-plugins/borderWaitData';
describe('editorial dates and border navigation', () => {
  it('uses the recorded revision, not the build clock or publication date', () => {
    const date = '2026-01-01T00:00:00+01:00';
    expect(editorialModifiedDate(JSON.stringify({'@type':'Article',datePublished:'2020-02-01',dateModified:date}), '</script>')).toBe(date);
    expect(editorialModifiedDate(JSON.stringify({'@type':'Article',datePublished:'2020-02-01'}), '</script>')).toBeUndefined();
    expect(editorialModifiedDate(undefined, '</script>')).toBeUndefined();
    expect(editorialModifiedDate('{invalid', '</script>')).toBeUndefined();
    expect(editorialModifiedDate(JSON.stringify({'@type':'Dataset',dateModified:date}), '</script>')).toBeUndefined();
    expect(editorialModifiedDate(JSON.stringify({'@graph':[{'@type':['Article'],dateModified:date}]}), '</script>')).toBe(date);
  });
  it('synchronizes sitemap lastmod with the matching editorial date', () => {
    const xml = [
      '<urlset>',
      '  <url><loc>https://frontaliereticino.ch/one/</loc><lastmod>2026-04-09</lastmod></url>',
      '  <url><loc>https://frontaliereticino.ch/two/</loc></url>',
      '  <url><loc>https://frontaliereticino.ch/three/</loc><lastmod>2026-04-09</lastmod></url>',
      '</urlset>',
    ].join('\n');

    const synchronized = synchronizeSitemapLastmods(xml, (loc) => {
      if (loc.endsWith('/one/')) return '2026-01-01T00:00:00+01:00';
      if (loc.endsWith('/two/')) return '2026-02-02';
      return undefined;
    });

    expect(synchronized).toContain('<loc>https://frontaliereticino.ch/one/</loc><lastmod>2026-01-01</lastmod>');
    expect(synchronized).toContain('<loc>https://frontaliereticino.ch/two/</loc>\n    <lastmod>2026-02-02</lastmod></url>');
    expect(synchronized).toContain('<loc>https://frontaliereticino.ch/three/</loc><lastmod>2026-04-09</lastmod>');
  });
  it.each(BORDER_WAIT_LOCALES)('links to the matching dashboard in %s', locale => {
    expect(renderBorderDashboardLink(locale)).toContain(`href="${buildRootHubPath(locale)}"`);
  });
});
