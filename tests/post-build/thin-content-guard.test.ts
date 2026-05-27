import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist');
const DOMAIN = 'https://frontaliereticino.ch/';
const MIN_WORDS = 50;

/**
 * Extract all URLs from all sitemaps in dist/.
 */
function extractSitemapUrls(): { sitemap: string; relPath: string }[] {
  if (!existsSync(DIST_DIR)) return [];
  const sitemaps = readdirSync(DIST_DIR).filter(
    (f) => f.startsWith('sitemap') && f.endsWith('.xml') && f !== 'sitemap.xml' && f !== 'sitemap_news.xml',
  );
  const urls: { sitemap: string; relPath: string }[] = [];
  for (const sm of sitemaps) {
    const content = readFileSync(path.join(DIST_DIR, sm), 'utf-8');
    const matches = [...content.matchAll(/<loc>([^<]+)<\/loc>/g)];
    for (const m of matches) {
      const url = m[1];
      if (!url.startsWith(DOMAIN) || url.endsWith('.xml')) continue;
      const relPath = url.slice(DOMAIN.length).replace(/\/$/, '');
      if (relPath) urls.push({ sitemap: sm, relPath });
    }
  }
  return urls;
}

function countWords(html: string): number {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(' ').filter((w) => w.length > 0).length;
}

const sitemapUrls = extractSitemapUrls();

describe('Thin content guard (post-build)', () => {
  it('should find sitemap URLs in dist', () => {
    expect(sitemapUrls.length).toBeGreaterThan(100);
  });

  it('every sitemap URL must have a corresponding index.html in dist/', () => {
    const missing: string[] = [];
    for (const { sitemap, relPath } of sitemapUrls) {
      const filePath = path.join(DIST_DIR, relPath, 'index.html');
      if (!existsSync(filePath)) {
        missing.push(`[${sitemap}] /${relPath}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it(`100% of sitemap pages must have >= ${MIN_WORDS} words (zero thin content)`, () => {
    const thinPages: string[] = [];
    for (const { sitemap, relPath } of sitemapUrls) {
      const filePath = path.join(DIST_DIR, relPath, 'index.html');
      if (!existsSync(filePath)) continue;
      const html = readFileSync(filePath, 'utf-8');
      const words = countWords(html);
      if (words < MIN_WORDS) {
        thinPages.push(`[${words}w] [${sitemap}] /${relPath}`);
      }
    }
    expect(thinPages).toEqual([]);
  });

  it('no noindex pages should appear in sitemaps', () => {
    const noindexPages: string[] = [];
    for (const { sitemap, relPath } of sitemapUrls) {
      const filePath = path.join(DIST_DIR, relPath, 'index.html');
      if (!existsSync(filePath)) continue;
      const html = readFileSync(filePath, 'utf-8');
      if (/<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) {
        noindexPages.push(`[${sitemap}] /${relPath}`);
      }
    }
    expect(noindexPages).toEqual([]);
  });
});
