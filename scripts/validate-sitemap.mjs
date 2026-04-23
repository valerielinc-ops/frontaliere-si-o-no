#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const BASE_URL = 'https://frontaliereticino.ch';

function normalize(pathname) {
 if (!pathname || pathname === '/') return '/';
 return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function collectIndexablePages(dir, out = []) {
 for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
   collectIndexablePages(full, out);
   continue;
  }
  if (!entry.isFile() || entry.name !== 'index.html') continue;
  const rel = path.relative(DIST, full);
  if (rel === 'index.html') {
   out.push('/');
   continue;
  }
  const relPath = '/' + rel.replace(/\/index\.html$/, '');
  const html = readFileSync(full, 'utf-8');
  if (/<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) continue;
  if (html.includes('__BRIDGE_TARGET_SLUG__')) continue;
  if (html.includes('<script>location.replace(')) continue;
  out.push(normalize(relPath));
 }
 return out;
}

const sitemapUrls = new Set();
for (const file of readdirSync(DIST).filter((name) => name.startsWith('sitemap') && name.endsWith('.xml')).sort()) {
 const xml = readFileSync(path.join(DIST, file), 'utf-8');
 if (xml.includes('<sitemapindex')) continue;
 for (const match of xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)) {
  const url = match[1].trim();
  if (!url.startsWith(BASE_URL) || url.endsWith('.xml')) continue;
  sitemapUrls.add(normalize(url.replace(BASE_URL, '') || '/'));
 }
}

const indexablePages = [...new Set(collectIndexablePages(DIST))];
const missing = indexablePages.filter((page) => !sitemapUrls.has(page));

if (missing.length > 0) {
 console.error(`❌ Sitemap completeness failed: ${missing.length} indexable page(s) missing from sitemap`);
 for (const page of missing.slice(0, 100)) {
  console.error(`- ${page}`);
 }
 if (missing.length > 100) {
  console.error(`... and ${missing.length - 100} more`);
 }
 process.exit(1);
}

console.log(`✅ Sitemap completeness passed for ${indexablePages.length} indexable page(s).`);
