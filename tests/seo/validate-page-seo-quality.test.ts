import { describe, expect, it } from 'vitest';
import {
  checkLangAttribute,
  collectHtmlFiles,
  hasMetaRefresh,
  hasMetaViewport,
  isIntentionalRedirectPage,
  validateBestPracticeSeo,
  validateSchemas,
} from '../../scripts/validate-page-seo-quality.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';
import { REDIRECT_STUB_MARKER } from '../../build-plugins/shared/redirectStubMarker.mjs';

const GOOD_PAGE = `
  <html>
    <head>
      <meta name=description content="Guida pratica ai servizi per frontalieri, con informazioni aggiornate e link utili.">
      <meta property="og:title" content="Guida > servizi per frontalieri">
      <meta property="og:description" content="Guida pratica ai servizi per frontalieri, con informazioni aggiornate e link utili.">
      <meta content="https://frontaliereticino.ch/en/guide/" property="og:url">
      <link href="https://frontaliereticino.ch/en/guide/" rel="canonical">
    </head>
    <body>
      <img src="/hero.webp" alt="Servizi per frontalieri">
      <img src="/decorative.webp" role="presentation none">
    </body>
  </html>
`;

describe('validateBestPracticeSeo', () => {
  it('accepts complete canonical, social, description, and image metadata', () => {
    expect(validateBestPracticeSeo(GOOD_PAGE, 'en/guide')).toEqual([]);
  });

  it('reports actionable advisory findings without treating them as blocking errors', () => {
    const html = `
      <meta name=description content="Breve">
      <link rel="canonical" href="/en/guide">
      <meta property="og:title" content="Guida">
      <meta name="twitter:title" content="Guida">
      <img src="/hero.webp">
    `;

    const issues = validateBestPracticeSeo(html, 'en/guide');
    const types = issues.map(issue => issue.type);

    expect(types).toEqual(expect.arrayContaining([
      'canonicalNotAbsolute',
      'canonicalMissingTrailingSlash',
      'missingOgDescription',
      'missingOgUrl',
      'partialTwitterCard',
      'shortMetaDescription',
      'missingImageAlt',
    ]));
    expect(types).not.toContain('canonicalMismatch');
  });

  it('does not create advisory noise for intentional noindex or refresh pages', () => {
    expect(validateBestPracticeSeo('<meta name=robots content=noindex>', 'en/search')).toEqual([]);
    expect(validateBestPracticeSeo('<meta http-equiv="refresh" content="0;url=/">', 'en/legacy')).toEqual([]);
  });

  it('does not confuse lookalike names or quoted values with real attributes', () => {
    const html = `
      <meta data-property="og:title" data-content="fake" property="og:title" content="A > useful title">
      <meta property="og:description" content="Description with enough context to describe the page clearly to visitors and search engines.">
      <meta property="og:url" content="https://frontaliereticino.ch/en/guide/">
      <meta name=description content="Description with enough context to describe the page clearly to visitors and search engines.">
      <link data-href="https://example.com/" rel="canonical" href="https://frontaliereticino.ch/en/guide/">
      <img src="/hero.webp?alt=lookalike" data-alt="also-lookalike">
    `;

    const types = validateBestPracticeSeo(html, 'en/guide').map(issue => issue.type);
    expect(types).not.toContain('missingOgTitle');
    expect(types).not.toContain('missingOgDescription');
    expect(types).not.toContain('missingOgUrl');
    expect(types).toContain('missingImageAlt');
  });
});

describe('blocking page checks', () => {
  it('accepts HTML5-unquoted lang and viewport emitted by the real minifier', () => {
    const html = minifyHtml(`
      <!doctype html>
      <html lang="fr">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
      </html>
    `);

    expect(html).toMatch(/<html\s+lang=fr>/);
    expect(html).toMatch(/<meta\s+name=viewport\s+content=/);
    expect(checkLangAttribute(html, 'fr')).toBeNull();
    expect(hasMetaViewport(html)).toBe(true);
  });

  it('ignores a JSON-LD-looking script tag inside an HTML comment', () => {
    const html = `
      <!-- Documentation: <script type="application/ld+json">not JSON</script> -->
      <script type=application/ld+json>{"@type":"JobPosting"}</script>
      <script type="application/ld+json">{"@type":"FAQPage"}</script>
    `;

    expect(validateSchemas(html)).toEqual([]);
  });

  it('lets FAQPage sit next to the main entity, and still blocks two different main entities', () => {
    const jobDetail = validateSchemas(`
      <script type="application/ld+json">{"@type":"JobPosting"}</script>
      <script type="application/ld+json">{"@type":"FAQPage"}</script>
      <script type="application/ld+json">{"@type":"WebPage"}</script>
    `);
    const glossary = validateSchemas(`
      <script type="application/ld+json">{"@graph":[{"@type":"DefinedTerm"},{"@type":"FAQPage"}]}</script>
    `);
    const conflict = validateSchemas(`
      <script type="application/ld+json">{"@type":"Article"}</script>
      <script type="application/ld+json">{"@type":"JobPosting"}</script>
    `);

    expect(jobDetail).toEqual([]);
    expect(glossary).toEqual([]);
    expect(conflict).toEqual([
      expect.objectContaining({ type: 'conflicting-schemas', detail: 'Multiple primary schemas: Article, JobPosting' }),
    ]);
  });

  it('keeps duplicate and genuinely invalid JSON-LD blocking', () => {
    const duplicate = validateSchemas(`
      <script type="application/ld+json">{"@type":"FAQPage"}</script>
      <script type="application/ld+json">{"@type":"FAQPage"}</script>
    `);
    const invalid = validateSchemas('<script type="application/ld+json">not JSON</script>');

    expect(duplicate).toEqual([
      expect.objectContaining({ type: 'conflicting-schemas' }),
    ]);
    expect(invalid).toEqual([
      expect.objectContaining({ type: 'invalid-json' }),
    ]);
  });

  it('recognizes marked noindex/meta-refresh redirect bridges', () => {
    const html = `${REDIRECT_STUB_MARKER}
      <html lang="it">
        <meta name="robots" content="noindex,follow">
        <meta http-equiv=refresh content="0; url=/cerca-lavoro-ticino/">
      </html>`;

    expect(hasMetaRefresh(html)).toBe(true);
    expect(isIntentionalRedirectPage(html)).toBe(true);
  });
});

describe('collectHtmlFiles', () => {
  it('handles a child directory with more pages than a spread call can accept', () => {
    const pageCount = 130_000;
    const entries = Array.from({ length: pageCount }, (_, index) => `page-${index}`);
    const fakeFs = {
      readdirSync(dir: string) {
        if (dir === 'dist') return ['section'];
        if (dir === 'dist/section') return entries;
        return ['index.html'];
      },
      statSync(filePath: string) {
        return { isDirectory: () => !filePath.endsWith('index.html') };
      },
    };

    expect(collectHtmlFiles('dist', '', fakeFs)).toHaveLength(pageCount);
  });
});
