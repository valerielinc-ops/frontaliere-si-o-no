import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileArticleSitemapsWithDist,
  reconcileFinalSitemapsWithDist,
} from '../build-plugins/sitemapAliasPlugin';
import { extractSitemapLocs } from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';
const NOINDEX = `${BASE}/de/grenzgaenger-artikel/placeholder-article/`;
const HEALTHY = `${BASE}/en/cross-border-articles/real-article/`;
const DRIFT = `${BASE}/fr/articles-frontalier/canonical-drift-article/`;
const BRIDGE = `${BASE}/it/articoli-frontalieri/previous-article-slug/`;
const MISSING = `${BASE}/fr/articles-frontalier/foreign-shard-article/`;
const STATIC_NOINDEX = `${BASE}/about/legacy-noindex/`;
const STATIC_DRIFT = `${BASE}/contact/legacy-canonical-drift/`;
const STATIC_BRIDGE = `${BASE}/privacy-policy/legacy-alias/`;

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
    urlset([NOINDEX, HEALTHY, DRIFT, BRIDGE, MISSING]),
    'utf8',
  );
  writePage(
    NOINDEX,
    `<meta name="robots" content="noindex,follow"><link rel="canonical" href="${NOINDEX}">`,
  );
  writePage(HEALTHY, `<link rel="canonical" href="${HEALTHY}">`);
  writePage(DRIFT, `<link rel="canonical" href="${HEALTHY}">`);
  writePage(
    BRIDGE,
    `<meta name="robots" content="index,follow"><link rel="canonical" href="${HEALTHY}">` +
      '<!-- __BRIDGE_TARGET_SLUG__ -->',
  );
});

afterEach(() => {
 vi.restoreAllMocks();
 fs.rmSync(dist, { recursive: true, force: true });
});

describe('reconcileArticleSitemapsWithDist', () => {
  it('removes a present noindex article and keeps healthy and foreign-shard URLs', async () => {
    const removed = await reconcileArticleSitemapsWithDist(dist);
    const xml = fs.readFileSync(path.join(dist, 'sitemap-locale-variants-001.xml'), 'utf8');

    expect(removed).toBe(2);
    expect(extractSitemapLocs(xml)).toEqual([HEALTHY, BRIDGE, MISSING]);
    expect(fs.existsSync(path.join(dist, 'de/grenzgaenger-artikel/placeholder-article/index.html'))).toBe(true);
  });

  it('does not alter a sitemap when no article HTML is found', async () => {
    const file = path.join(dist, 'sitemap-locale-variants-001.xml');
    fs.writeFileSync(file, urlset([HEALTHY, MISSING]), 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(dist, 'en'), { recursive: true, force: true });

    await reconcileArticleSitemapsWithDist(dist);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('applies the same final-dist predicate to an unowned static sitemap family', async () => {
    const file = path.join(dist, 'sitemap-pages.xml');
    fs.writeFileSync(file, urlset([STATIC_NOINDEX, STATIC_DRIFT, STATIC_BRIDGE]), 'utf8');
    writePage(
      STATIC_NOINDEX,
      `<meta name="robots" content="noindex,follow"><link rel="canonical" href="${STATIC_NOINDEX}">`,
    );
    writePage(STATIC_DRIFT, `<link rel="canonical" href="${HEALTHY}">`);
    writePage(
      STATIC_BRIDGE,
      `<link rel="canonical" href="${HEALTHY}"><!-- __BRIDGE_TARGET_SLUG__ -->`,
    );

    await reconcileFinalSitemapsWithDist(dist, []);

    expect(extractSitemapLocs(fs.readFileSync(file, 'utf8'))).toEqual([STATIC_BRIDGE]);
  });

  it('propagates a non-ENOENT candidate read error', async () => {
    const permissionDenied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(permissionDenied);

    await expect(reconcileArticleSitemapsWithDist(dist)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
