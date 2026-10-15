import { test, expect } from 'playwright/test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

function urlsFromXml(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => {
      try {
        return new URL(m[1]).pathname;
      } catch {
        return null;
      }
    })
    .filter((p): p is string => p !== null);
}

function collectPageUrls(): string[] {
  const index = readFileSync(resolve(DIST, 'sitemap.xml'), 'utf-8');
  const subSitemaps = urlsFromXml(index).filter((p) => p.endsWith('.xml'));
  const all = new Set<string>();
  for (const sub of subSitemaps) {
    const rel = sub.replace(/^\//, '');
    const full = resolve(DIST, rel);
    if (!existsSync(full)) continue;
    const xml = readFileSync(full, 'utf-8');
    for (const u of urlsFromXml(xml)) all.add(u);
  }
  if (all.size === 0) {
    // Flat sitemap (no index) — parse root directly for page URLs.
    for (const u of urlsFromXml(index)) all.add(u);
  }
  return [...all];
}

test('every sitemap URL has a static HTML file in dist/', () => {
  const urls = collectPageUrls();
  expect(urls.length, 'sitemap contains page URLs').toBeGreaterThan(100);
  const missing: string[] = [];
  for (const p of urls) {
    const filePath = resolve(DIST, p.replace(/^\//, '').replace(/\/$/, '/index.html'));
    if (!existsSync(filePath)) missing.push(p);
  }
  expect(missing, `Missing static HTML for: ${missing.slice(0, 10).join(', ')}`).toHaveLength(0);
});

test.describe('namespaced page smoke crawl', () => {
  const NAMESPACES = [
    '/aziende-che-assumono/',
    '/traffico-dogane/',
    '/prezzi-benzina/',
    '/premi-cassa-malati/',
  ];
  for (const ns of NAMESPACES) {
    test(`namespace has >=5 URLs in sitemap: ${ns}`, () => {
      const urls = collectPageUrls().filter((u) => u.startsWith(ns));
      expect(urls.length, `pages under ${ns}`).toBeGreaterThanOrEqual(5);
    });
  }
});

test('no company-city empty shells leak into sitemap', () => {
  const urls = collectPageUrls();
  // Pattern: /aziende-che-assumono/{city}/{company}/settimana-corrente/
  // Every such URL must have a generated static HTML file.
  const companyCity = urls.filter((u) =>
    /^\/aziende-che-assumono\/[^/]+\/[^/]+\/settimana-corrente\/$/.test(u)
  );
  const missing = companyCity.filter((p) => {
    const filePath = resolve(DIST, p.replace(/^\//, '').replace(/\/$/, '/index.html'));
    return !existsSync(filePath);
  });
  expect(missing, `Company-city URLs in sitemap without page: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0);
});
