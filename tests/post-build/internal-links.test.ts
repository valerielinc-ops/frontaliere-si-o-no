import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
 extractInternalLinks,
 listSitemapHtmlPages,
 urlToDistPath,
} from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();

describe('Internal links (post-build)', () => {
 it('all internal links on sitemap pages resolve to an existing dist file', () => {
  const failures = new Set<string>();

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   const links = extractInternalLinks(html, page.url);
   for (const href of links) {
    const target = urlToDistPath(href);
    if (!existsSync(target)) {
     failures.add(`${page.relPath} -> ${href}`);
    }
   }
  }

  expect([...failures]).toEqual([]);
 });
});
