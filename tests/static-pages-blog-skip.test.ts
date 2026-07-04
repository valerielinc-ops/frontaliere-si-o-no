import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('static pages blog detail rendering', () => {
  it('renders rich blog detail content instead of the generic editorial stub', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
    expect(source).toContain('const isBlogDetailPage = blogSlugs.includes(firstSeg)');
    // Rich content still derives from blogSectionData; since #3521 the html is
    // rendered via the shared dedupe-heading renderer instead of an inline map.
    expect(source).toContain('const blogArticleHtml = renderArticleDerivedSectionsHtml(blogSectionData');
    // The wrapper div previously carried `style="max-width:56rem;margin:0 auto;padding:1rem"`
    // inline; after the 2026-05-20 inline-style → class extraction, the same rule lives
    // in seo-static.css under a content-hashed class (s-wWmcGm at time of writing).
    // The assertion accepts EITHER the legacy literal or the new class form so the test
    // survives further class-name churn driven by upstream style edits.
    expect(source).toMatch(/\?\s*`<div (style="max-width:56rem;margin:0 auto;padding:1rem"|class="s-[A-Za-z0-9_-]+")>\$\{heroImg\}<article>/);
  });
});

describe('ogPagesPlugin skip-set covers every article section (no missingTarget race)', () => {
  // Regression for validate-dist [missingTarget] (run 27998666257, 2026-06-23):
  // staticPagesPlugin built its ogPagesPlugin skip-set from the `frontaliere`
  // section ONLY, while ogPagesPlugin emits BOTH `frontaliere` and `svizzera`
  // sections. The omitted section fell through to the racy fs.existsSync check
  // under parallel closeBundle → cross-plugin write collision → a freshly
  // published svizzera article emitted FR but dropped IT/EN/DE, failing
  // audit-hreflang. The skip-set must list EVERY section ogPagesPlugin owns.
  const ogSource = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'ogPagesPlugin.ts'), 'utf-8');
  const staticSource = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

  it('staticPagesPlugin skip-set references the slugData of every ogPagesPlugin SECTION', () => {
    const ogSlugData = [...ogSource.matchAll(/slugData:\s*'([^']+)'/g)].map((m) => m[1]);
    // ogPagesPlugin owns ≥2 article sections (frontaliere + svizzera).
    expect(ogSlugData).toContain('services/routerBlogData.ts');
    expect(ogSlugData).toContain('services/routerSwissData.ts');
    for (const slugData of ogSlugData) {
      expect(
        staticSource.includes(slugData),
        `staticPagesPlugin skip-set must read ${slugData} (an ogPagesPlugin article section) or its pages race on fs.existsSync`,
      ).toBe(true);
    }
  });

  it('skip-set parse derives all four locale paths for a svizzera article', () => {
    const root = path.resolve(__dirname, '..');
    const seoSrc = readFileSync(path.resolve(root, 'services/seo/seo-blog-ch.ts'), 'utf-8');
    const routerSrc = readFileSync(path.resolve(root, 'services/routerSwissData.ts'), 'utf-8');
    const indexSlugs: Record<'en' | 'de' | 'fr', string> = {
      en: 'swiss-articles', de: 'schweiz-artikel', fr: 'articles-suisse',
    };

    const itPaths = [...seoSrc.matchAll(/canonicalPath:\s*'([^']+)'/g)].map(
      (m) => m[1].replace(/\/+$/, '') || '/',
    );
    const slugMap: Record<string, Record<string, string>> = {};
    for (const m of routerSrc.matchAll(
      /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g,
    )) {
      slugMap[m[2]] = { en: m[3], de: m[4], fr: m[5] };
    }

    const skip = new Set<string>();
    for (const itPath of itPaths) {
      skip.add(itPath);
      const itSlug = itPath.split('/').filter(Boolean).pop();
      const loc = itSlug ? slugMap[itSlug] : undefined;
      if (!loc) continue;
      for (const l of ['en', 'de', 'fr'] as const) {
        if (loc[l]) skip.add(`/${l}/${indexSlugs[l]}/${loc[l]}`);
      }
    }

    // At least one svizzera article must round-trip through all four locales.
    const sample = Object.keys(slugMap).find((id) => skip.has(`/articoli-svizzera/${id}`));
    expect(sample, 'no svizzera article canonical path parsed from seo-blog-ch.ts').toBeTruthy();
    const s = slugMap[sample as string];
    expect(skip.has(`/articoli-svizzera/${sample}`)).toBe(true);
    expect(skip.has(`/en/swiss-articles/${s.en}`)).toBe(true);
    expect(skip.has(`/de/schweiz-artikel/${s.de}`)).toBe(true);
    expect(skip.has(`/fr/articles-suisse/${s.fr}`)).toBe(true);
  });
});
