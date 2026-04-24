import { test, expect } from 'playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

function extractSitemapUrls(): string[] {
  const xml = readFileSync(resolve(DIST, 'sitemap.xml'), 'utf-8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
}

test('every sitemap URL has a static HTML file in dist/', () => {
  const urls = extractSitemapUrls();
  expect(urls.length, 'sitemap is not empty').toBeGreaterThan(100);
  const missing: string[] = [];
  for (const p of urls) {
    const filePath = resolve(DIST, p.replace(/^\//, '').replace(/\/$/, '/index.html'));
    if (!existsSync(filePath)) missing.push(p);
  }
  expect(missing, `Missing static HTML for: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0);
});

test.describe('namespaced page smoke crawl', () => {
  const NAMESPACES = [
    '/aziende-che-assumono/',
    '/traffico-dogane/',
    '/prezzi-benzina-oggi/',
    '/lavori-frontalieri/',
  ];
  for (const ns of NAMESPACES) {
    test(`namespace has >=5 URLs in sitemap: ${ns}`, () => {
      const urls = extractSitemapUrls().filter((u) => u.startsWith(ns));
      expect(urls.length, `pages under ${ns}`).toBeGreaterThanOrEqual(5);
    });
  }
});
