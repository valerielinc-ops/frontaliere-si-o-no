import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const seoSource = readFileSync(path.join(ROOT, 'services/seo/seo-pages.ts'), 'utf8');
const sitemap = readFileSync(path.join(ROOT, 'public/sitemap-pages.xml'), 'utf8');

describe('for-employers landing SEO contract', () => {
  const routes = [
    '/per-le-aziende/',
    '/en/for-employers/',
    '/de/fuer-unternehmen/',
    '/fr/pour-les-entreprises/',
  ];

  it('has localized metadata entries for all four public landing URLs', () => {
    for (const route of routes) {
      expect(seoSource, route).toContain(`canonicalPath: '${route}'`);
      expect(sitemap, route).toContain(`<loc>https://frontaliereticino.ch${route}</loc>`);
    }
  });

  it('keeps the public employer landing indexable and out of the private publisher routes', () => {
    expect(seoSource).toContain("'for-employers': {");
    expect(sitemap).toContain('hreflang="x-default" href="https://frontaliereticino.ch/per-le-aziende/"');
    expect(sitemap).not.toContain('<loc>https://frontaliereticino.ch/pubblica-offerta/</loc>');
    expect(sitemap).not.toContain('<loc>https://frontaliereticino.ch/i-miei-annunci/</loc>');
  });
});
