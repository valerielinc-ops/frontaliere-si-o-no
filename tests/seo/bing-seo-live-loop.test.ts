import { describe, expect, it } from 'vitest';

import {
  auditHtml,
  auditLive,
  parseHtmlContract,
} from '../../scripts/seo/bing-seo-live-loop.mjs';
import {
  BING_INDEXNOW_REMEDIATION_URLS,
  BING_TITLE_AUDIT_URLS,
  BING_TITLE_MAX_CHARS,
} from '../../scripts/seo/bing-seo-policy.mjs';

const URL = 'https://frontaliereticino.ch/';

describe('Bing SEO live contract', () => {
  it('accepts one visible homepage H1 and a matching canonical', () => {
    const html = [
      '<html><head>',
      '<title>Frontaliere Ticino | Frontaliere Ticino</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/">',
      '</head><body><main><h1 id="homepage-static-h1">Frontaliere Ticino 2026</h1></main></body></html>',
    ].join('');

    const result = auditHtml(URL, html, { homepage: true });
    expect(result.findings).toEqual([]);
    expect(result.h1s).toEqual([{ text: 'Frontaliere Ticino 2026', hidden: false }]);
  });

  it('flags an offscreen H1 even when the tag exists', () => {
    const html = [
      '<title>Frontaliere Ticino</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/">',
      '<h1 style="position:absolute;left:-9999px;width:1px;height:1px">Home</h1>',
    ].join('');

    expect(auditHtml(URL, html, { homepage: true }).findings.map((item) => item.code))
      .toContain('homepage-h1-hidden');
  });

  it('flags title overflow and canonical drift', () => {
    const html = [
      '<title>',
      'Titolo volutamente molto lungo che supera il limite Bing per verificare il gate automatico',
      '</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/altra-pagina/">',
    ].join('');

    const findings = auditHtml(URL, html).findings.map((item) => item.code);
    expect(findings).toEqual(expect.arrayContaining(['title-too-long', 'canonical-drift']));
  });

  it('keeps the observed policy sets unique and bounded', () => {
    expect(new Set(BING_TITLE_AUDIT_URLS).size).toBe(BING_TITLE_AUDIT_URLS.length);
    expect(new Set(BING_INDEXNOW_REMEDIATION_URLS).size).toBe(BING_INDEXNOW_REMEDIATION_URLS.length);
    expect(BING_TITLE_MAX_CHARS).toBe(66);
    expect(parseHtmlContract('<h1>ok</h1>').h1s).toHaveLength(1);
  });

  it('accepts a canonical after redirect and reports a stale IndexNow URL as warning', async () => {
    const titleUrl = BING_TITLE_AUDIT_URLS[0];
    const staleUrl = BING_INDEXNOW_REMEDIATION_URLS.at(-1);
    const redirectedUrl = titleUrl.replace(/\/$/, '-2026/');
    const html = (title, canonical, h1 = '') => [
      '<title>', title, '</title>',
      '<link rel="canonical" href="', canonical, '">',
      h1 ? '<h1>' + h1 + '</h1>' : '',
    ].join('');

    const result = await auditLive({
      homepageUrl: URL,
      titleUrls: [titleUrl],
      indexNowUrls: [staleUrl],
      fetchImpl: async (url) => {
        if (url === URL) {
          return {
            status: 200,
            url,
            text: async () => html('Frontaliere Ticino', url, 'Homepage'),
          };
        }
        if (url === titleUrl) {
          return {
            status: 200,
            url: redirectedUrl,
            text: async () => html('Titolo articolo entro il limite', redirectedUrl),
          };
        }
        return {
          status: 404,
          url,
          text: async () => '<title>Pagina non trovata</title>',
        };
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toEqual(['indexnow-stale-url']);
  });
});
