import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist');
export const BASE_URL = 'https://frontaliereticino.ch';

export interface SitemapPage {
 sitemap: string;
 url: string;
 relPath: string;
 filePath: string;
}

function stripOrigin(url: string): string {
 return url.replace(BASE_URL, '');
}

export function normalizePathname(pathname: string): string {
 if (!pathname || pathname === '/') return '/';
 return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function urlToDistPath(url: string): string {
 const noHash = url.split('#')[0];
 const noQuery = noHash.split('?')[0];
 const pathname = stripOrigin(noQuery) || '/';

 if (pathname === '/' || pathname === '') {
  return path.join(DIST_DIR, 'index.html');
 }

 const rel = pathname.replace(/^\//, '').replace(/\/$/, '');
 if (path.extname(rel)) {
  return path.join(DIST_DIR, rel);
 }
 return path.join(DIST_DIR, rel, 'index.html');
}

export function extractCanonical(html: string): string | null {
 return html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] ?? null;
}

export function extractAlternates(html: string): Map<string, string> {
 const out = new Map<string, string>();
 const regex = /<link\s+rel="alternate"[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/gi;
 let match: RegExpExecArray | null;
 while ((match = regex.exec(html)) !== null) {
  out.set(match[1], match[2]);
 }
 return out;
}

export function extractJsonLdBlocks(html: string): unknown[] {
 const out: unknown[] = [];
 const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
 let match: RegExpExecArray | null;
 while ((match = regex.exec(html)) !== null) {
  try {
   out.push(JSON.parse(match[1]));
  } catch {
   // Parsing validity is covered by dedicated validators.
  }
 }
 return out;
}

export function flattenSchemas(value: unknown): Record<string, any>[] {
 const out: Record<string, any>[] = [];

 const visit = (node: unknown) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
   for (const item of node) visit(item);
   return;
  }
  const record = node as Record<string, any>;
  if (record['@type']) out.push(record);
  for (const nested of Object.values(record)) visit(nested);
 };

 const blocks = Array.isArray(value) ? value : [value];
 for (const block of blocks) visit(block);
 return out;
}

export function listSitemapPages(): SitemapPage[] {
 if (!existsSync(DIST_DIR)) return [];

 const sitemapFiles = readdirSync(DIST_DIR)
  .filter((file) => file.startsWith('sitemap') && file.endsWith('.xml'))
  .sort();

 const pages: SitemapPage[] = [];
 for (const sitemap of sitemapFiles) {
  const xml = readFileSync(path.join(DIST_DIR, sitemap), 'utf-8');
  if (xml.includes('<sitemapindex')) continue;

  const matches = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)];
  for (const match of matches) {
   const url = match[1].trim();
   if (!url.startsWith(BASE_URL) || url.endsWith('.xml')) continue;
   const relPath = normalizePathname(stripOrigin(url) || '/');
   pages.push({
    sitemap,
    url,
    relPath,
    filePath: urlToDistPath(url),
   });
  }
 }

 return pages;
}

export function listSitemapHtmlPages(): SitemapPage[] {
 return listSitemapPages().filter((page) => !path.extname(page.relPath));
}

export function extractInternalLinks(html: string, pageUrl: string): string[] {
 const out = new Set<string>();
 const regex = /<a\b[^>]*href="([^"]+)"/gi;
 let match: RegExpExecArray | null;

 while ((match = regex.exec(html)) !== null) {
  const raw = match[1].trim();
  if (!raw || raw.startsWith('#')) continue;
  if (/^(mailto|tel|javascript):/i.test(raw)) continue;

  try {
   const resolved = new URL(raw, pageUrl);
   if (resolved.origin !== BASE_URL) continue;
   resolved.hash = '';
   resolved.search = '';
   out.add(resolved.toString());
  } catch {
   // Ignore malformed hrefs here; missing targets are still caught by validators.
  }
 }

 return [...out];
}

export function pathLocale(relPath: string): 'it' | 'en' | 'de' | 'fr' {
 if (relPath === '/en' || relPath.startsWith('/en/')) return 'en';
 if (relPath === '/de' || relPath.startsWith('/de/')) return 'de';
 if (relPath === '/fr' || relPath.startsWith('/fr/')) return 'fr';
 return 'it';
}
