import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

import { listSitemapHtmlPages } from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();
const borderWaitPages = sitemapPages.filter((page) => page.sitemap === 'sitemap-border-wait.xml');

describe('Sitemap completeness (post-build)', () => {
 it('includes the border wait sitemap entries in dist', () => {
  expect(borderWaitPages.length).toBeGreaterThanOrEqual(20);
  expect(borderWaitPages.every((page) => existsSync(page.filePath))).toBe(true);
 });

 it('does not reference missing files in any sitemap', () => {
  const missing = sitemapPages.filter((page) => !existsSync(page.filePath));
  expect(missing).toEqual([]);
 });
});
