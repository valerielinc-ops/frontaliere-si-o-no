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
import {
  emitSitemapXml,
  isAuthoritativeJobSitemapShardFilename,
  partitionSitemapUrlBlocks,
  splitToShards,
  syncAuthoritativeJobSitemapIndex,
  writeShardsToDist,
} from '../scripts/lib/sitemap-shard.mjs';
import { SITEMAP_SHARD_CAP } from '../scripts/lib/sitemap-limits.mjs';
import { dedupeUrlsetXmlByLoc } from '../build-plugins/shared/sitemapUrlsetDedupe';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const countLoc = (xml: string, loc: string): number =>
  xml.split(`<loc>${loc}</loc>`).length - 1;

describe('emitSitemapXml — per-file <loc> dedup (#3516)', () => {
  it('recognizes only numbered authoritative legacy continuations', () => {
    expect(isAuthoritativeJobSitemapShardFilename('sitemap-jobs-legacy-001.xml')).toBe(true);
    expect(isAuthoritativeJobSitemapShardFilename('sitemap-jobs-legacy-12.xml')).toBe(true);
    expect(isAuthoritativeJobSitemapShardFilename('sitemap-jobs-zurigo.xml')).toBe(false);
    expect(isAuthoritativeJobSitemapShardFilename('sitemap-jobs-expired-001.xml')).toBe(false);
  });

  it('partitions the primary legacy urlset at the shared cap without dropping blocks', () => {
    expect(partitionSitemapUrlBlocks(['a', 'b', 'c'], { capPerShard: 2 })).toEqual({
      primary: ['a', 'b'],
      overflow: ['c'],
    });
  });

  it('preserves two-decimal priorities when routing entries into canton shards', () => {
    const xml = emitSitemapXml([
      { loc: 'https://frontaliereticino.ch/de/jobs-im-aargau/baden/', priority: 0.85 },
      { loc: 'https://frontaliereticino.ch/de/jobs-im-aargau/', priority: 0.7 },
    ]);

    expect(xml).toContain('<priority>0.85</priority>');
    expect(xml).toContain('<priority>0.7</priority>');
  });

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

describe('writeShardsToDist — stale shard cleanup', () => {
  it('removes old job shards before the auto-discovery sweep can republish them', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-shard-cleanup-'));
    try {
      fs.writeFileSync(path.join(dist, 'sitemap-jobs-argovia.xml'), '<stale/>');
      fs.writeFileSync(path.join(dist, 'sitemap-jobs-expired.xml'), '<stale/>');
      fs.writeFileSync(path.join(dist, 'sitemap-jobs-legacy-001.xml'), '<authoritative/>');
      fs.writeFileSync(path.join(dist, 'sitemap-pages.xml'), '<keep/>');

      await writeShardsToDist(
        [{ filename: 'sitemap-jobs-zurigo.xml', urls: [{ loc: 'https://frontaliereticino.ch/a/' }] }],
        dist,
        'https://frontaliereticino.ch',
      );

      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-argovia.xml'))).toBe(false);
      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-expired.xml'))).toBe(false);
      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-legacy-001.xml'))).toBe(true);
      expect(fs.existsSync(path.join(dist, 'sitemap-pages.xml'))).toBe(true);
      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-zurigo.xml'))).toBe(true);
      expect(fs.readFileSync(path.join(dist, 'sitemap-index.xml'), 'utf8'))
        .toContain('sitemap-jobs-zurigo.xml');
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('removes the nested shard index when the current build has no shards', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-shard-empty-'));
    try {
      fs.writeFileSync(path.join(dist, 'sitemap-jobs-argovia.xml'), '<stale/>');
      fs.writeFileSync(path.join(dist, 'sitemap-index.xml'), '<stale-index/>');

      await writeShardsToDist([], dist, 'https://frontaliereticino.ch');

      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-argovia.xml'))).toBe(false);
      expect(fs.existsSync(path.join(dist, 'sitemap-index.xml'))).toBe(false);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('syncAuthoritativeJobSitemapIndex — root discovery', () => {
  it('indexes the overflow file and removes its stale entry on a 39,000-URL rerun', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-root-index-'));
    const base = 'https://frontaliereticino.ch';
    const header = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n';
    const urlBlock = (index: number) => ` <url><loc>${base}/job-${index}/</loc></url>`;
    try {
      fs.writeFileSync(
        path.join(dist, 'sitemap-jobs.xml'),
        `${header}${Array.from({ length: SITEMAP_SHARD_CAP }, (_, index) => urlBlock(index)).join('\n')}\n</urlset>\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(dist, 'sitemap-jobs-legacy-001.xml'),
        `${header}${urlBlock(SITEMAP_SHARD_CAP)}\n</urlset>\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(dist, 'sitemap.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex>\n`
          + ` <sitemap><loc>${base}/sitemap-jobs.xml</loc><lastmod>2026-11-15</lastmod></sitemap>\n`
          + ` <sitemap><loc>${base}/sitemap-jobs-legacy-001.xml</loc><lastmod>2026-11-15</lastmod></sitemap>\n`
          + ` <sitemap><loc>${base}/sitemap-jobs-legacy-099.xml</loc><lastmod>2026-11-15</lastmod></sitemap>\n`
          + `</sitemapindex>\n`,
        'utf8',
      );

      await syncAuthoritativeJobSitemapIndex(dist, base, '2026-11-16');

      let indexXml = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
      expect(indexXml.split(`${base}/sitemap-jobs.xml`).length - 1).toBe(1);
      expect(indexXml.split(`${base}/sitemap-jobs-legacy-001.xml`).length - 1).toBe(1);
      expect(indexXml).not.toContain('sitemap-jobs-legacy-099.xml');

      fs.rmSync(path.join(dist, 'sitemap-jobs-legacy-001.xml'));
      await syncAuthoritativeJobSitemapIndex(dist, base, '2026-11-16');
      indexXml = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
      expect(indexXml).not.toContain('sitemap-jobs-legacy-001.xml');
      expect(indexXml).toContain(`${base}/sitemap-jobs.xml`);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
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
