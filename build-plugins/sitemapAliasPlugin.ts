/**
 * Post-build sitemap tasks:
 * 1. Keep backward compatibility with the legacy sitemap_news.xml filename
 * 2. Stamp today's date into sitemap index <lastmod> so it's never stale
 */

import path from 'path';
import type { Plugin } from 'vite';

export function sitemapAliasPlugin(rootDir: string): Plugin {
 return {
 name: 'sitemap-alias',
 apply: 'build',
 async closeBundle() {
 const fs = await import('node:fs');
 const distDir = path.resolve(rootDir, 'dist');

 // 1. Legacy alias: sitemap-news.xml → sitemap_news.xml
 const source = path.join(distDir, 'sitemap-news.xml');
 const target = path.join(distDir, 'sitemap_news.xml');
 if (fs.existsSync(source)) {
 fs.copyFileSync(source, target);
 console.log('\x1b[36m[sitemap-alias]\x1b[0m Created sitemap_news.xml alias');
 }

 // 2. Update sitemap index lastmod to today's date
 const indexPath = path.join(distDir, 'sitemap.xml');
 if (fs.existsSync(indexPath)) {
 const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
 const content = fs.readFileSync(indexPath, 'utf-8');
 const updated = content.replace(
 /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g,
 `<lastmod>${today}</lastmod>`,
 );
 fs.writeFileSync(indexPath, updated);
 console.log(`\x1b[36m[sitemap-alias]\x1b[0m Updated sitemap index lastmod → ${today}`);
 }
 },
 };
}
