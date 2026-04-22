#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const BASE_URL = 'https://frontaliereticino.ch';

function normalize(url) {
 return url.replace(/\/$/, '');
}

function urlToFile(url) {
 const clean = url.split('#')[0].split('?')[0];
 const pathname = clean.replace(BASE_URL, '') || '/';
 if (pathname === '/' || pathname === '') return path.join(DIST, 'index.html');
 const rel = pathname.replace(/^\//, '').replace(/\/$/, '');
 if (path.extname(rel)) return path.join(DIST, rel);
 return path.join(DIST, rel, 'index.html');
}

function sitemapPages() {
 const out = [];
 for (const file of readdirSync(DIST).filter((name) => name.startsWith('sitemap') && name.endsWith('.xml')).sort()) {
  const xml = readFileSync(path.join(DIST, file), 'utf-8');
  if (xml.includes('<sitemapindex')) continue;
  for (const match of xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)) {
   const url = match[1].trim();
   if (!url.startsWith(BASE_URL) || url.endsWith('.xml')) continue;
   const relPath = (url.replace(BASE_URL, '') || '/').replace(/\/$/, '') || '/';
   if (path.extname(relPath)) continue;
   out.push({ file, url, relPath, htmlFile: urlToFile(url) });
  }
 }
 return out;
}

function extractAlternates(html) {
 const out = new Map();
 const regex = /<link\s+rel="alternate"[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/gi;
 let match;
 while ((match = regex.exec(html)) !== null) out.set(match[1], match[2]);
 return out;
}

const pages = sitemapPages();
const failures = [];

for (const page of pages) {
 if (!existsSync(page.htmlFile)) continue;
 const html = readFileSync(page.htmlFile, 'utf-8');
 const alternates = extractAlternates(html);

 if (!alternates.size) {
  failures.push(`${page.relPath} — missing hreflang links`);
  continue;
 }

 const itHref = alternates.get('it');
 const xDefault = alternates.get('x-default');
 if (itHref && xDefault && normalize(itHref) !== normalize(xDefault)) {
  failures.push(`${page.relPath} — x-default must match IT href`);
 }

 for (const [hreflang, href] of alternates) {
  if (!href.startsWith(BASE_URL)) continue;
  const target = urlToFile(href);
  if (!existsSync(target)) {
   failures.push(`${page.relPath} — hreflang ${hreflang} target missing: ${href}`);
  }
 }
}

if (failures.length > 0) {
 console.error(`❌ Hreflang validation failed: ${failures.length} issue(s)`);
 for (const failure of failures.slice(0, 100)) {
  console.error(`- ${failure}`);
 }
 if (failures.length > 100) {
  console.error(`... and ${failures.length - 100} more`);
 }
 process.exit(1);
}

console.log(`✅ Hreflang validation passed on ${pages.length} sitemap page(s).`);
