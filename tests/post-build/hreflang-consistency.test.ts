import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
 BASE_URL,
 extractAlternates,
 listSitemapHtmlPages,
 urlToDistPath,
} from './seo-helpers';
import { findHreflangReciprocityFailures } from '../../scripts/lib/hreflang-reciprocity.mjs';
import { isExternallyServedUrl } from '../../scripts/lib/externally-served-paths.mjs';

const sitemapPages = listSitemapHtmlPages();

describe('Hreflang consistency (post-build)', () => {
 it('finds sitemap-backed pages in dist', () => {
  expect(sitemapPages.length).toBeGreaterThan(100);
 });

 it('every sitemap page points hreflang URLs to existing files and keeps x-default on IT', () => {
  const failures: string[] = [];
  const pages: Array<{ url: string; relPath: string; alternates: Map<string, string> }> = [];

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   const alternates = extractAlternates(html);

   if (!alternates.size) {
    failures.push(`${page.relPath}: no hreflang links found`);
    continue;
   }

   pages.push({ url: page.url, relPath: page.relPath, alternates });

   const itHref = alternates.get('it');
   const xDefault = alternates.get('x-default');
   if (itHref && xDefault && itHref.replace(/\/$/, '') !== xDefault.replace(/\/$/, '')) {
    failures.push(`${page.relPath}: x-default does not match IT hreflang`);
   }

   for (const [hreflang, href] of alternates) {
    if (!href.startsWith(BASE_URL) || isExternallyServedUrl(href)) continue;
    const target = urlToDistPath(href);
    if (!existsSync(target)) {
      failures.push(`${page.relPath}: hreflang ${hreflang} -> missing ${href}`);
    }
   }
  }

  for (const issue of findHreflangReciprocityFailures(pages, {
   baseUrl: BASE_URL,
   skipTarget: isExternallyServedUrl,
  })) {
   failures.push(`${issue.sourcePath}: hreflang ${issue.hreflang} -> ${issue.target} has no reciprocal link back`);
  }

  expect(failures).toEqual([]);
 });
});
