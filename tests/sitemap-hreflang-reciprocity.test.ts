/**
 * Regression tests for the dist-side sitemap hreflang-reciprocity sanitizer
 * (issue #3474).
 *
 * Google's sitemap-hreflang method requires every alternate referenced by an
 * `xhtml:link` annotation to appear as its own `<url><loc>` entry (in any of
 * the site's sitemaps) carrying a return annotation. The committed
 * blog/blog-ch/glossario/news sitemaps annotate IT-only `<loc>` entries whose
 * EN/DE/FR alternates are listed nowhere, so those annotation groups are
 * ignored by Google and surface as "no return tag" noise in Search Console.
 *
 * `sanitizeSitemapHreflangReciprocity` (build-plugins/sitemapAliasPlugin.ts)
 * strips one-sided groups from the emitted dist/ copies and keeps complete
 * groups (sitemap-salary-hub.xml pattern) byte-identical. These tests pin:
 *
 * 1. Fixture-level behaviour: strip one-sided, keep reciprocal, cross-file
 *    resolution, return-tag requirement, fixpoint cascade, loc preservation.
 * 2. Real-file invariants on the committed public/ sitemaps: every
 *    annotation surviving the sanitizer satisfies reciprocity, `<loc>`
 *    entries are NEVER added or removed, and the known one-sided files
 *    (blog, blog-ch, glossario, news) come out with zero annotations.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeSitemapHreflangReciprocity,
  type SitemapXmlFile,
} from '../build-plugins/sitemapAliasPlugin';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://frontaliereticino.ch';

const ann = (lang: string, href: string) =>
  `    <xhtml:link rel="alternate" hreflang="${lang}" href="${href}" />`;

/** Pretty-printed <url> block in the committed public/ sitemap shape. */
const urlBlock = (loc: string, annotations: readonly string[]) =>
  ['  <url>', `    <loc>${loc}</loc>`, ...annotations, '    <lastmod>2026-04-03</lastmod>', '  </url>'].join('\n');

const urlset = (...blocks: readonly string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${blocks.join('\n')}\n</urlset>\n`;

const countLocs = (xml: string) => [...xml.matchAll(/<loc>/g)].length;
const countAnnotations = (xml: string) => [...xml.matchAll(/<xhtml:link\b/g)].length;

describe('sanitizeSitemapHreflangReciprocity — fixtures', () => {
  const itLoc = `${BASE}/articoli-frontaliere/esempio/`;
  const enLoc = `${BASE}/en/cross-border-articles/example/`;
  const fullGroup = () => [
    ann('it', itLoc),
    ann('en', enLoc),
    ann('x-default', itLoc),
  ];

  it('strips a one-sided group (alternates listed nowhere) but preserves the <url>/<loc> entries', () => {
    const xml = urlset(
      urlBlock(itLoc, [ann('it', itLoc), ann('en', enLoc), ann('x-default', itLoc)]),
    );
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-blog.xml', xml }]);

    expect(out.has('sitemap-blog.xml')).toBe(true);
    const sanitized = out.get('sitemap-blog.xml')!;
    expect(countAnnotations(sanitized)).toBe(0);
    expect(countLocs(sanitized)).toBe(1);
    expect(sanitized).toContain(`<loc>${itLoc}</loc>`);
    expect(sanitized).toContain('<lastmod>2026-04-03</lastmod>');
    // No dangling blank lines where the annotations used to be.
    expect(sanitized).not.toMatch(/\n[ \t]*\n/);
  });

  it('keeps a complete reciprocal group byte-identical (salary-hub pattern)', () => {
    const xml = urlset(
      urlBlock(itLoc, fullGroup()),
      urlBlock(enLoc, fullGroup()),
    );
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-salary-hub.xml', xml }]);
    // Nothing changed → file not in the output map at all.
    expect(out.size).toBe(0);
  });

  it('resolves reciprocity across files (alternate listed in a sibling sitemap)', () => {
    const fileA: SitemapXmlFile = {
      file: 'sitemap-a.xml',
      xml: urlset(urlBlock(itLoc, fullGroup())),
    };
    const fileB: SitemapXmlFile = {
      file: 'sitemap-b.xml',
      xml: urlset(urlBlock(enLoc, fullGroup())),
    };
    const out = sanitizeSitemapHreflangReciprocity([fileA, fileB]);
    expect(out.size).toBe(0);
  });

  it('strips when the alternate is a listed <loc> WITHOUT a return annotation (bare-loc jobs pattern)', () => {
    const xml = urlset(
      urlBlock(itLoc, [ann('it', itLoc), ann('en', enLoc)]),
      urlBlock(enLoc, []), // listed, but does not annotate back
    );
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-mixed.xml', xml }]);
    const sanitized = out.get('sitemap-mixed.xml')!;
    expect(countAnnotations(sanitized)).toBe(0);
    expect(countLocs(sanitized)).toBe(2);
  });

  it('cascades to a fixpoint: stripping an invalid group also strips neighbours that relied on its return tag', () => {
    const cLoc = `${BASE}/de/grenzgaenger-artikel/beispiel/`; // never a <loc>
    const xml = urlset(
      // A ↔ B reciprocal…
      urlBlock(itLoc, [ann('it', itLoc), ann('en', enLoc)]),
      // …but B's group also references C, which is listed nowhere → B is
      // stripped → A loses its return tag → A must be stripped too.
      urlBlock(enLoc, [ann('it', itLoc), ann('en', enLoc), ann('de', cLoc)]),
    );
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-cascade.xml', xml }]);
    const sanitized = out.get('sitemap-cascade.xml')!;
    expect(countAnnotations(sanitized)).toBe(0);
    expect(countLocs(sanitized)).toBe(2);
  });

  it('leaves annotation-free sitemaps untouched', () => {
    const xml = urlset(urlBlock(itLoc, []), urlBlock(enLoc, []));
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-jobs-ticino.xml', xml }]);
    expect(out.size).toBe(0);
  });

  it('parses the compact single-line emit shape used by plugin-emitted sitemaps', () => {
    // salaryHubPlugin emits `<xhtml:link rel="alternate" hreflang=".." href=".."/>`
    // (no space before `/>`), blocks joined without pretty-print guarantees.
    const compact =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n` +
      `  <url>\n    <loc>${itLoc}</loc>\n    <xhtml:link rel="alternate" hreflang="it" href="${itLoc}"/>\n    <xhtml:link rel="alternate" hreflang="en" href="${enLoc}"/>\n  </url>\n` +
      `</urlset>\n`;
    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-compact.xml', xml: compact }]);
    const sanitized = out.get('sitemap-compact.xml')!;
    expect(countAnnotations(sanitized)).toBe(0);
    expect(countLocs(sanitized)).toBe(1);
  });
});

describe('sanitizeSitemapHreflangReciprocity — committed public/ sitemaps', () => {
  const publicDir = path.join(ROOT, 'public');
  const files: SitemapXmlFile[] = fs
    .readdirSync(publicDir)
    .filter((f) => /^sitemap-[a-z0-9][a-z0-9-]*\.xml$/i.test(f))
    .map((file) => ({
      file,
      xml: fs.readFileSync(path.join(publicDir, file), 'utf-8'),
    }));
  const sanitizedXml = new Map(files.map((f) => [f.file, f.xml] as const));
  for (const [file, xml] of sanitizeSitemapHreflangReciprocity(files)) {
    sanitizedXml.set(file, xml);
  }

  it('never adds or removes a <loc> entry in any sitemap', () => {
    for (const { file, xml } of files) {
      const before = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      const after = [...sanitizedXml.get(file)!.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      expect(after, file).toEqual(before);
    }
  });

  it('fully strips the known one-sided files (blog, blog-ch, glossario, news) — issue #3474', () => {
    for (const file of ['sitemap-blog.xml', 'sitemap-blog-ch.xml', 'sitemap-glossario.xml', 'sitemap-news.xml']) {
      const xml = sanitizedXml.get(file);
      expect(xml, `${file} missing from public/`).toBeDefined();
      expect(countAnnotations(xml!), file).toBe(0);
    }
  });

  it('every surviving annotation satisfies reciprocity (alternate is a listed <loc> with a return tag)', () => {
    const locSet = new Set<string>();
    const annotationsByLoc = new Map<string, Set<string>>();
    for (const xml of sanitizedXml.values()) {
      for (const blockMatch of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
        const block = blockMatch[0];
        const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
        if (!loc) continue;
        locSet.add(loc);
        for (const el of block.matchAll(/<xhtml:link\b[^>]*?\/>/g)) {
          const href = el[0].match(/href="([^"]+)"/)?.[1];
          if (!href) continue;
          let set = annotationsByLoc.get(loc);
          if (!set) {
            set = new Set<string>();
            annotationsByLoc.set(loc, set);
          }
          set.add(href);
        }
      }
    }
    const violations: string[] = [];
    for (const [loc, hrefs] of annotationsByLoc) {
      for (const href of hrefs) {
        if (!locSet.has(href)) violations.push(`${loc} → ${href} (alternate not a listed <loc>)`);
        else if (!annotationsByLoc.get(href)?.has(loc)) violations.push(`${loc} → ${href} (no return tag)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the reciprocal-complete groups of sitemap-pages.xml (never strips a correct signal)', () => {
    const xml = sanitizedXml.get('sitemap-pages.xml')!;
    // The 7 top-level tab pages are listed in all 4 locales with symmetric
    // annotation groups (28 <url> blocks × 5 annotations) — they must survive.
    expect(countAnnotations(xml)).toBeGreaterThanOrEqual(28 * 5);
    expect(xml).toContain(`hreflang="en" href="${BASE}/en/tax/"`);
  });
});
