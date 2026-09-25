/**
 * #911 — relatedSearchClustersPlugin drops its cross-section legacy mirror URLs
 * (canonical → Svizzera) from sitemap-jobs.xml, which jobsSeoPagesPlugin emits
 * as self-canonical TI before our HTML overwrite. A non-self-canonical <loc>
 * fails the 0-tolerance audit:sitemap-canonicals gate → blocks publish.
 * These tests pin the pure block-dropping core (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import { dropUrlBlocksByLoc } from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';
const urlBlock = (loc: string): string =>
  ` <url>\n  <loc>${loc}</loc>\n  <lastmod>2026-05-29</lastmod>\n  <changefreq>weekly</changefreq>\n  <priority>0.5</priority>\n </url>`;
// Production format from jobsSeoPagesPlugin.ts (L7688/L7462): alternates between <loc> and <lastmod>.
const urlBlockWithAlternates = (loc: string): string => {
  const alternates = ['it', 'en', 'de', 'fr']
    .map((l) => ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE}/cerca-lavoro-ticino/ricerca-test-${l}/" />`)
    .join('\n');
  return ` <url>\n <loc>${loc}</loc>\n${alternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${loc}" />\n <lastmod>2026-05-29</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`;
};
const wrap = (blocks: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${blocks.join('\n')}\n</urlset>\n`;

const TI = `${BASE}/cerca-lavoro-ticino/ricerca-projektleiter-m-w-d/`;
const CH = `${BASE}/cerca-lavoro-svizzera/ricerca-projektleiter-m-w-d/`;
const JOB = `${BASE}/cerca-lavoro-ticino/sviluppatore-acme-lugano/`;

describe('dropUrlBlocksByLoc (#911 sitemap-jobs mirror drop)', () => {
  it('drops the cross-section TI mirror, keeps CH canonical + job detail', () => {
    const xml = wrap([urlBlock(TI), urlBlock(CH), urlBlock(JOB)]);
    const { xml: out, dropped } = dropUrlBlocksByLoc(xml, [TI]);
    expect(dropped).toBe(1);
    expect(out).not.toContain('cerca-lavoro-ticino/ricerca-projektleiter');
    expect(out).toContain('cerca-lavoro-svizzera/ricerca-projektleiter'); // canonical survives
    expect(out).toContain('sviluppatore-acme-lugano'); // job detail untouched
  });

  it('matches trailing-slash + host-case insensitively', () => {
    const xml = wrap([urlBlock(TI)]);
    // mirror loc supplied without trailing slash and with mixed-case host
    const { dropped } = dropUrlBlocksByLoc(xml, [
      'https://FrontaliereTicino.ch/cerca-lavoro-ticino/ricerca-projektleiter-m-w-d',
    ]);
    expect(dropped).toBe(1);
  });

  it('empty mirror list → byte-identical output', () => {
    const xml = wrap([urlBlock(TI), urlBlock(JOB)]);
    const { xml: out, dropped } = dropUrlBlocksByLoc(xml, []);
    expect(dropped).toBe(0);
    expect(out).toBe(xml);
  });

  it('counts multiple drops, preserves unrelated blocks', () => {
    const A = `${BASE}/cerca-lavoro-ticino/ricerca-a/`;
    const B = `${BASE}/cerca-lavoro-ticino/ricerca-b/`;
    const xml = wrap([urlBlock(A), urlBlock(JOB), urlBlock(B)]);
    const { xml: out, dropped } = dropUrlBlocksByLoc(xml, [A, B]);
    expect(dropped).toBe(2);
    expect(out).toContain('sviluppatore-acme-lugano');
    expect(out).not.toContain('ricerca-a/');
    expect(out).not.toContain('ricerca-b/');
  });

  it('exact-loc match only — does not drop unrelated URLs', () => {
    const xml = wrap([urlBlock(JOB)]);
    const { dropped } = dropUrlBlocksByLoc(xml, [TI]);
    expect(dropped).toBe(0);
  });

  it('drops block with xhtml:link alternates between <loc> and <lastmod> (production format)', () => {
    // jobsSeoPagesPlugin emits <xhtml:link rel="alternate" hreflang="…"/> lines
    // between <loc> and <lastmod> (L7688/L7462). Regression guard: LOC_RE must
    // still match and the block-regex must still span the whole multi-line block.
    const xml = wrap([urlBlockWithAlternates(TI), urlBlockWithAlternates(CH)]);
    const { xml: out, dropped } = dropUrlBlocksByLoc(xml, [TI]);
    expect(dropped).toBe(1);
    expect(out).not.toContain('cerca-lavoro-ticino/ricerca-projektleiter');
    expect(out).toContain('cerca-lavoro-svizzera/ricerca-projektleiter'); // CH block survives intact
    // The surviving CH block must retain its alternates (block not truncated).
    expect(out).toContain('xhtml:link');
  });
});
