/**
 * The cluster sitemap is written before serialized post-phase emitters finish.
 * The final sitemap-alias hook must remove a cluster URL when one of those
 * emitters has replaced its HTML with a noindex document.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileSitemapSearchClustersWithDist } from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';
const HEALTHY = `${BASE}/cerca-lavoro-svizzera/ricerca-indexable-lugano/`;
const LATE_NOINDEX = `${BASE}/cerca-lavoro-svizzera/ricerca-late-overwrite/`;

const urlBlock = (loc: string) =>
  `  <url>\n    <loc>${loc}</loc>\n    <lastmod>2026-09-26</lastmod>\n  </url>`;

const urlset = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  `${locs.map(urlBlock).join('\n')}\n</urlset>\n`;

function pagePath(distDir: string, loc: string): string {
  return path.join(distDir, new URL(loc).pathname.replace(/^\/+|\/+$/g, ''), 'index.html');
}

let distDir: string;

beforeEach(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-final-dist-truth-'));
  fs.writeFileSync(
    path.join(distDir, 'sitemap-search-clusters-001.xml'),
    urlset([HEALTHY, LATE_NOINDEX]),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(distDir, 'sitemap-search-clusters-002.xml'),
    urlset([HEALTHY]),
    'utf-8',
  );

  fs.mkdirSync(path.dirname(pagePath(distDir, HEALTHY)), { recursive: true });
  fs.writeFileSync(
    pagePath(distDir, HEALTHY),
    `<html><head><link rel="canonical" href="${HEALTHY}"></head><body>ok</body></html>`,
    'utf-8',
  );

  // Simulate the late emitter: the cluster producer initially wrote an
  // indexable page, then a later owner replaced the same path with a bridge.
  fs.mkdirSync(path.dirname(pagePath(distDir, LATE_NOINDEX)), { recursive: true });
  fs.writeFileSync(
    pagePath(distDir, LATE_NOINDEX),
    `<html><head><meta name="robots" content="noindex,follow">` +
      `<link rel="canonical" href="${BASE}/cerca-lavoro-svizzera/"></head>` +
      `<body>bridge</body></html>`,
    'utf-8',
  );
});

afterEach(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('reconcileSitemapSearchClustersWithDist', () => {
  it('removes late noindex overwrites from every cluster shard and keeps healthy URLs', async () => {
    await expect(reconcileSitemapSearchClustersWithDist(distDir)).resolves.toBe(1);

    const first = fs.readFileSync(path.join(distDir, 'sitemap-search-clusters-001.xml'), 'utf-8');
    const second = fs.readFileSync(path.join(distDir, 'sitemap-search-clusters-002.xml'), 'utf-8');
    expect(first).not.toContain(LATE_NOINDEX);
    expect(first).toContain(HEALTHY);
    expect(second).toContain(HEALTHY);
  });

  it('does not rewrite unrelated sitemap families', async () => {
    const jobsPath = path.join(distDir, 'sitemap-jobs.xml');
    fs.writeFileSync(jobsPath, urlset([LATE_NOINDEX]), 'utf-8');

    await reconcileSitemapSearchClustersWithDist(distDir);

    expect(fs.readFileSync(jobsPath, 'utf-8')).toContain(LATE_NOINDEX);
  });
});
