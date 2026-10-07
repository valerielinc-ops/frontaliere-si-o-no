import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileArticleSitemapsWithDist } from '../build-plugins/sitemapAliasPlugin';
import { extractSitemapLocs } from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';
const NOINDEX = `${BASE}/de/grenzgaenger-artikel/placeholder-article/`;
const HEALTHY = `${BASE}/en/cross-border-articles/real-article/`;
const MISSING = `${BASE}/fr/articles-frontalier/foreign-shard-article/`;

const urlset = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  locs.map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`).join('\n') +
  '\n</urlset>\n';

let dist: string;

function writePage(loc: string, html: string): void {
  const relative = new URL(loc).pathname.replace(/^\/+|\/+$/g, '');
  const dir = path.join(dist, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'article-sitemap-dist-truth-'));
  fs.writeFileSync(
    path.join(dist, 'sitemap-locale-variants-001.xml'),
    urlset([NOINDEX, HEALTHY, MISSING]),
    'utf8',
  );
  writePage(NOINDEX, '<meta name="robots" content="noindex,follow">');
  writePage(HEALTHY, `<meta name="robots" content="index,follow">`);
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('reconcileArticleSitemapsWithDist', () => {
  it('removes a present noindex article and keeps healthy and foreign-shard URLs', async () => {
    const removed = await reconcileArticleSitemapsWithDist(dist);
    const xml = fs.readFileSync(path.join(dist, 'sitemap-locale-variants-001.xml'), 'utf8');

    expect(removed).toBe(1);
    expect(extractSitemapLocs(xml)).toEqual([HEALTHY, MISSING]);
    expect(fs.existsSync(path.join(dist, 'de/grenzgaenger-artikel/placeholder-article/index.html'))).toBe(true);
  });

  it('does not alter a sitemap when no indexed article is found', async () => {
    const file = path.join(dist, 'sitemap-locale-variants-001.xml');
    const before = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(dist, 'de'), { recursive: true, force: true });

    await reconcileArticleSitemapsWithDist(dist);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
