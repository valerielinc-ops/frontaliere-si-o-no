#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const BASE_URL = 'https://frontaliereticino.ch';
const minWordsArg = process.argv.find((arg) => arg.startsWith('--min-words='));
const MIN_WORDS = Number(minWordsArg?.split('=')[1] || '300');
const FAIL_ON_ANY = process.argv.includes('--fail-on-any');

function urlToFile(url) {
 const pathname = (url.replace(BASE_URL, '') || '/').replace(/\/$/, '') || '/';
 if (pathname === '/') return path.join(DIST, 'index.html');
 const rel = pathname.replace(/^\//, '');
 if (path.extname(rel)) return path.join(DIST, rel);
 return path.join(DIST, rel, 'index.html');
}

function countWords(html) {
 const text = html
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
 return text ? text.split(' ').filter(Boolean).length : 0;
}

const thinPages = [];

for (const file of readdirSync(DIST).filter((name) => name.startsWith('sitemap') && name.endsWith('.xml')).sort()) {
 const xml = readFileSync(path.join(DIST, file), 'utf-8');
 if (xml.includes('<sitemapindex')) continue;
 for (const match of xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)) {
  const url = match[1].trim();
  if (!url.startsWith(BASE_URL) || url.endsWith('.xml')) continue;
  const htmlFile = urlToFile(url);
  if (!existsSync(htmlFile)) {
   thinPages.push({ url, words: 0, reason: 'missing file' });
   continue;
  }

  const html = readFileSync(htmlFile, 'utf-8');
  if (html.includes('__BRIDGE_TARGET_SLUG__')) continue;
  const words = countWords(html);
  if (words < MIN_WORDS) {
   thinPages.push({ url, words, reason: `below ${MIN_WORDS}` });
  }
 }
}

if (thinPages.length === 0) {
 console.log(`✅ No thin pages found below ${MIN_WORDS} words.`);
 process.exit(0);
}

console.log(`⚠️ Found ${thinPages.length} thin page(s) below ${MIN_WORDS} words:`);
for (const entry of thinPages.slice(0, 100)) {
 console.log(`- [${entry.words}w] ${entry.url} (${entry.reason})`);
}
if (thinPages.length > 100) {
 console.log(`... and ${thinPages.length - 100} more`);
}

process.exit(FAIL_ON_ANY ? 1 : 0);
