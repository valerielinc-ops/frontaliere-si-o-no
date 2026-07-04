/**
 * #3516 — duplicate <url> entries WITHIN a single sitemap file.
 *
 * Two emission paths are covered:
 *  - object-entry shards: `emitSitemapXml` (scripts/lib/sitemap-shard.mjs)
 *  - string-assembled urlsets: `dedupeUrlsetXmlByLoc`
 *    (build-plugins/shared/sitemapUrlsetDedupe.ts), used by the legacy
 *    sitemap-jobs.xml and sitemap-eventi.xml assemblers.
 *
 * Cross-shard dual-emit (same URL in *different* files) is intentional and
 * must stay possible — both dedupes are scoped to one document.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helper without type declarations
import { emitSitemapXml, splitToShards } from '../scripts/lib/sitemap-shard.mjs';
import { dedupeUrlsetXmlByLoc } from '../build-plugins/shared/sitemapUrlsetDedupe';

const countLoc = (xml: string, loc: string): number =>
  xml.split(`<loc>${loc}</loc>`).length - 1;

describe('emitSitemapXml — per-file <loc> dedup (#3516)', () => {
  it('emits a repeated loc only once (keep-first)', () => {
    const xml = emitSitemapXml([
      { loc: 'https://frontaliereticino.ch/a/', lastmod: '2026-01-01', priority: 0.6 },
      { loc: 'https://frontaliereticino.ch/b/', lastmod: '2026-01-02', priority: 0.6 },
      { loc: 'https://frontaliereticino.ch/a/', lastmod: '2026-01-03', priority: 0.6 },
      { loc: 'https://frontaliereticino.ch/a/', lastmod: '2026-01-04', priority: 0.6 },
    ]);
    expect(countLoc(xml, 'https://frontaliereticino.ch/a/')).toBe(1);
    expect(countLoc(xml, 'https://frontaliereticino.ch/b/')).toBe(1);
    // keep-first: the first entry's lastmod survives
    expect(xml).toContain('<lastmod>2026-01-01</lastmod>');
    expect(xml).not.toContain('<lastmod>2026-01-03</lastmod>');
  });

  it('keeps the same URL across DIFFERENT shard files (dual-emit untouched)', () => {
    const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/x/';
    const shards = splitToShards(
      [
        { loc: url, _canton: 'TI' },
        { loc: url, _canton: 'ZH' },
      ],
      { shardKey: (u: { _canton: string }) => u._canton },
    );
    expect(shards).toHaveLength(2);
    for (const shard of shards) {
      expect(countLoc(emitSitemapXml(shard.urls), url)).toBe(1);
    }
  });
});

describe('dedupeUrlsetXmlByLoc — string-assembled urlsets (#3516)', () => {
  const block = (loc: string, extra = ''): string =>
    ` <url>\n <loc>${loc}</loc>\n${extra} <lastmod>2026-01-01</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`;

  it('drops repeated <url> blocks keep-first and keeps distinct ones', () => {
    const hreflang =
      ' <xhtml:link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/eventi/basilea/" />\n';
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      block('https://frontaliereticino.ch/eventi/basilea/', hreflang),
      block('https://frontaliereticino.ch/eventi/ticino/'),
      block('https://frontaliereticino.ch/eventi/basilea/', hreflang),
      '</urlset>',
      '',
    ].join('\n');
    const out = dedupeUrlsetXmlByLoc(xml);
    expect(countLoc(out, 'https://frontaliereticino.ch/eventi/basilea/')).toBe(1);
    expect(countLoc(out, 'https://frontaliereticino.ch/eventi/ticino/')).toBe(1);
    // Children of the kept block survive intact.
    expect(out).toContain('hreflang="it"');
    // Document shell intact.
    expect(out).toContain('<urlset');
    expect(out).toContain('</urlset>');
    expect(out.split('<url>').length - 1).toBe(2);
  });

  it('is a no-op on a urlset without duplicates', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      block('https://frontaliereticino.ch/a/'),
      block('https://frontaliereticino.ch/b/'),
      '</urlset>',
      '',
    ].join('\n');
    expect(dedupeUrlsetXmlByLoc(xml)).toBe(xml);
  });
});

describe('public/sitemap-pages.xml — committed source has no duplicate <loc> (#3516)', () => {
  it('every <loc> appears exactly once', async () => {
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(new URL('../public/sitemap-pages.xml', import.meta.url), 'utf-8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const dupes = locs.filter((l, i) => locs.indexOf(l) !== i);
    expect(dupes).toEqual([]);
  });
});
