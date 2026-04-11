#!/usr/bin/env node
/**
 * Cleanup sitemap-news.xml — keep only articles from the last 48 hours.
 * 
 * Google News Sitemap spec: only articles published in the last 2 days
 * should be included. Older entries are ignored by Google anyway.
 * 
 * Usage: node scripts/cleanup-news-sitemap.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITEMAP_PATH = resolve(__dirname, '..', 'public', 'sitemap-news.xml');
const MAX_AGE_HOURS = 48;

const src = readFileSync(SITEMAP_PATH, 'utf-8');

// Extract all <url>...</url> blocks
const urlBlocks = [...src.matchAll(/<url>\s*[\s\S]*?<\/url>/g)].map(m => m[0]);

const now = Date.now();
const cutoff = now - MAX_AGE_HOURS * 60 * 60 * 1000;

let kept = 0;
let removed = 0;

const freshBlocks = urlBlocks.filter(block => {
  const dateMatch = block.match(/<news:publication_date>([^<]+)<\/news:publication_date>/);
  if (!dateMatch) return true; // keep if no date found (safety)
  
  const pubDate = new Date(dateMatch[1]).getTime();
  if (isNaN(pubDate)) return true; // keep if unparseable
  if (pubDate >= cutoff) {
    kept++;
    return true;
  } else {
    removed++;
    return false;
  }
});

// Strip deprecated <news:keywords> tags (removed from Google spec in 2023)
const hasKeywords = freshBlocks.some(b => b.includes('<news:keywords>'));
const strippedBlocks = freshBlocks.map(block =>
  block.replace(/\s*<news:keywords>[^<]*<\/news:keywords>/g, '')
);

if (removed === 0 && !hasKeywords) {
  console.log(`ℹ️  sitemap-news.xml: all ${kept} articles are fresh (< ${MAX_AGE_HOURS}h), no deprecated tags — no cleanup needed`);
  process.exit(0);
}

// Rebuild the XML — preserve original namespaces
const nsMatch = src.match(/<urlset[^>]*>/);
const header = nsMatch?.[0] || `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">`;

const xmlDecl = src.includes('<?xml') ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '';
const output = xmlDecl + header + '\n\n' + strippedBlocks.map(b => '  ' + b.replace(/^  /gm, '  ')).join('\n\n') + '\n\n</urlset>\n';

writeFileSync(SITEMAP_PATH, output, 'utf-8');
const parts = [];
if (removed > 0) parts.push(`removed ${removed} articles older than ${MAX_AGE_HOURS}h`);
if (hasKeywords) parts.push('stripped deprecated <news:keywords> tags');
console.log(`✅ sitemap-news.xml: kept ${kept}${parts.length ? ', ' + parts.join(', ') : ''}`);
