import { describe, expect, it } from 'vitest';
import { validateBestPracticeSeo } from '../../scripts/validate-page-seo-quality.mjs';

const GOOD_PAGE = `
  <html>
    <head>
      <meta name=description content="Guida pratica ai servizi per frontalieri, con informazioni aggiornate e link utili.">
      <meta property="og:title" content="Guida per frontalieri">
      <meta property="og:description" content="Guida pratica ai servizi per frontalieri, con informazioni aggiornate e link utili.">
      <meta content="https://frontaliereticino.ch/en/guide/" property="og:url">
      <link href="https://frontaliereticino.ch/en/guide/" rel="canonical">
    </head>
    <body>
      <img src="/hero.webp" alt="Servizi per frontalieri">
      <img src="/decorative.webp" role="presentation">
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
});
