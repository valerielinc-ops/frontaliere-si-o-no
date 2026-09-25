import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { extractCanonical, listSitemapHtmlPages } from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();

describe('Canonical presence (post-build)', () => {
 it('every sitemap-backed HTML page has a canonical tag', () => {
  const failures: string[] = [];

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   if (!extractCanonical(html)) {
    failures.push(page.relPath);
   }
  }

  expect(failures).toEqual([]);
 });
});
