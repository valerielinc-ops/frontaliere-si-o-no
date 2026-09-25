import { describe, expect, it } from 'vitest';
import { collectHtmlFiles, validateBestPracticeSeo } from '../../scripts/validate-page-seo-quality.mjs';

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
