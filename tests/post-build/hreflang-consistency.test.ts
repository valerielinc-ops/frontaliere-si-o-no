import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
 BASE_URL,
 extractAlternates,
 listSitemapHtmlPages,
 urlToDistPath,
} from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();

describe('Hreflang consistency (post-build)', () => {
 it('finds sitemap-backed pages in dist', () => {
  expect(sitemapPages.length).toBeGreaterThan(100);
 });

 it('every sitemap page points hreflang URLs to existing files and keeps x-default on IT', () => {
  const failures: string[] = [];

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   const alternates = extractAlternates(html);

   if (!alternates.size) {
    failures.push(`${page.relPath}: no hreflang links found`);
    continue;
   }

   const itHref = alternates.get('it');
   const xDefault = alternates.get('x-default');
   if (itHref && xDefault && itHref.replace(/\/$/, '') !== xDefault.replace(/\/$/, '')) {
    failures.push(`${page.relPath}: x-default does not match IT hreflang`);
   }

   for (const [hreflang, href] of alternates) {
    if (!href.startsWith(BASE_URL)) continue;
    const target = urlToDistPath(href);
    if (!existsSync(target)) {
      failures.push(`${page.relPath}: hreflang ${hreflang} -> missing ${href}`);
    }
   }
  }

  expect(failures).toEqual([]);
 });
});
