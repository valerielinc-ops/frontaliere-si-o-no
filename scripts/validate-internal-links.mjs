#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const BASE_URL = 'https://frontaliereticino.ch';

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
   if (path.extname(url.replace(BASE_URL, ''))) continue;
   out.push({ url, htmlFile: urlToFile(url) });
  }
 }
 return out;
}

function extractInternalLinks(html, pageUrl) {
 const out = new Set();
 const regex = /<a\b[^>]*href="([^"]+)"/gi;
 let match;
 while ((match = regex.exec(html)) !== null) {
  const raw = match[1].trim();
  if (!raw || raw.startsWith('#')) continue;
  if (/^(mailto|tel|javascript):/i.test(raw)) continue;
  try {
   const href = new URL(raw, pageUrl);
   if (href.origin !== BASE_URL) continue;
   href.hash = '';
   href.search = '';
   out.add(href.toString());
  } catch {
   // ignore malformed hrefs here
  }
 }
 return [...out];
}

const failures = new Set();

for (const page of sitemapPages()) {
 if (!existsSync(page.htmlFile)) continue;
 const html = readFileSync(page.htmlFile, 'utf-8');
 for (const href of extractInternalLinks(html, page.url)) {
  if (!existsSync(urlToFile(href))) {
   failures.add(`${page.url} -> ${href}`);
  }
 }
}

const failureList = [...failures];

if (failureList.length > 0) {
 console.error(`❌ Internal link validation failed: ${failureList.length} broken link(s)`);
 for (const failure of failureList.slice(0, 100)) {
  console.error(`- ${failure}`);
 }
 if (failureList.length > 100) {
  console.error(`... and ${failureList.length - 100} more`);
 }
 process.exit(1);
}

console.log('✅ Internal link validation passed.');
