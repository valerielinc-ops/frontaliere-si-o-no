import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS } from '../build-plugins/shared/articleSectionDescriptors';
import { parseStaticArticleBodyPreviews } from '../build-plugins/shared/staticArticleBodyPreviews';
import { hasArticleBodyPromptPlaceholder } from '../packages/articles/engine/shared/articleBodyQuality';
import {
  repairLegacyDoubleEscapedBreaks,
  tsStringEscapesWithNewlineAs,
  unescapeTsString,
} from '../scripts/lib/unescape-ts-string.mjs';
import { SKIP_LIVE_DATA } from './helpers/live-data';

describe('static article body preview source reader', () => {
  const sourcePath = 'services/locales/blog-body/it/alpha.ts';

  it('uses the complete TypeScript module and preserves the preview flattening contract', () => {
    const source = [
      'const translations: Record<string, string> = {',
      '  "blog.article.alpha.body1": "Prima\\nseconda\\tterza\\rquarta",',
      "  'blog.article.alpha.body2': 'legacy\\\\nbreak',",
      '  "blog.article.alpha.body3": `\u00c8 testo su\ndue righe`,',
      '  "blog.article.alpha.body4": "...\\nignored placeholder field",',
      '  "note": "blog.article.fake.body1: \'not an entry\'",',
      '};',
      'export default translations;',
    ].join('\n');

    expect(parseStaticArticleBodyPreviews(source, sourcePath)).toEqual({
      alpha: {
        body1: 'Prima seconda terzaquarta',
        body2: 'legacy break',
        body3: 'È testo su due righe',
      },
    });
  });

  it('rejects a malformed present module instead of returning fields parsed before the error', () => {
    const malformed = [
      'const translations: Record<string, string> = {',
      "  'blog.article.alpha.body1': 'valid placeholder ...',",
      '  "unrelated": `runtime ${notStatic}`,',
      '};',
      'export default translations;',
    ].join('\n');

    expect(() => parseStaticArticleBodyPreviews(malformed, sourcePath))
      .toThrow(/Interpolated template literal is not supported/u);
  });

  it('ignores valid fields outside the preview contract and accepts an empty translation record', () => {
    const source = [
      'const translations: Record<string, string> = {',
      "  'blog.article.alpha.title': 'Title',",
      "  'blog.article.alpha.body4': 'not checked by this preview',",
      '};',
      'export default translations;',
    ].join('\n');
    const emptySource = [
      'const translations: Record<string, string> = {};',
      'export default translations;',
    ].join('\n');

    expect(parseStaticArticleBodyPreviews(source, sourcePath)).toEqual({});
    expect(parseStaticArticleBodyPreviews(emptySource, sourcePath)).toEqual({});
  });

  it('keeps prototype-shaped article ids as own data keys', () => {
    const source = [
      'const translations: Record<string, string> = {',
      "  'blog.article.__proto__.body1': 'first body',",
      "  'blog.article.constructor.body1': 'second body',",
      '};',
      'export default translations;',
    ].join('\n');
    const previews = parseStaticArticleBodyPreviews(source, sourcePath);
    const constructorId: string = 'constructor';

    expect(Object.hasOwn(previews, '__proto__')).toBe(true);
    expect(previews['__proto__']?.body1).toBe('first body');
    expect(Object.hasOwn(previews, constructorId)).toBe(true);
    expect(previews[constructorId]?.body1).toBe('second body');
    expect(Object.prototype).not.toHaveProperty('body1');
  });

  it('matches the legacy preview repair on a tracked source and verifies placeholder/robots wiring', () => {
    const relativePath = 'packages/articles/content/blog-body/it/139-frontalieri-ticino-special-olympics.ts';
    const absolutePath = path.resolve(__dirname, '..', relativePath);
    const source = readFileSync(absolutePath, 'utf-8');
    const actual = parseStaticArticleBodyPreviews(source, absolutePath);
    const expected: Record<string, { body1?: string; body2?: string; body3?: string }> = Object.create(null);
    const legacyPattern = /'blog\.article\.([^']+)\.(body1|body2|body3)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

    let match: RegExpExecArray | null;
    while ((match = legacyPattern.exec(source)) !== null) {
      const [, articleId, field, rawValue] = match;
      const preview = repairLegacyDoubleEscapedBreaks(
        unescapeTsString(rawValue, tsStringEscapesWithNewlineAs(' ')),
        ' ',
      );
      (expected[articleId] ??= Object.create(null))[field as 'body1' | 'body2' | 'body3'] = preview;
    }

    expect(Object.keys(expected)).toEqual(['139-frontalieri-ticino-special-olympics']);
    expect(actual).toEqual(expected);
    expect(hasArticleBodyPromptPlaceholder(actual['139-frontalieri-ticino-special-olympics'])).toBe(false);

    const placeholderSource = [
      'const body: Record<string, string> = {',
      "  'blog.article.placeholder-robots.body1': '...',",
      '};',
      'export default body;',
    ].join('\n');
    const placeholder = parseStaticArticleBodyPreviews(placeholderSource, 'placeholder-robots.ts');
    expect(hasArticleBodyPromptPlaceholder(placeholder['placeholder-robots'])).toBe(true);

    const pluginSource = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
    expect(pluginSource).toContain('parseStaticArticleBodyPreviews(src, np.join(dir, file))');
    expect(pluginSource).toContain('const articleBodyHasPromptPlaceholder = isBlogDetailPage && hasArticleBodyPromptPlaceholder(localizedBody)');
    expect(pluginSource).toContain('<meta name="robots" content="${articleRobots}">');
  });
});

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

describe('static article heroes expose an early LCP preload', () => {
  const source = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

  it('selects the section or detail hero for both article sections', () => {
    expect(source).toContain('if (blogSlugs.has(firstSeg) || swissSlugs.has(firstSeg))');
    expect(source).toContain('const sectionHero = isSwissSection ? swissHeroImageStatic : blogHeroImageStatic;');
    expect(source).toContain('const articleIds = isSwissSection ? swissArticleIdByLocale : blogArticleIdByLocale;');
    expect(source).toContain('heroImageByArticleId[detailId]');
    expect(source).toContain('<link rel="preload" as="image" fetchpriority="high" href="${preloadHero}">');
  });

  it('passes the generated glossary hero into the hand-rolled shell preload list', () => {
    expect(source).toContain("const getPagePreloads = (urlPath: string, locale: string, generatedHeroUrl = '')");
    expect(source).toContain('if (generatedHeroUrl)');
    expect(source).toContain('glossaryHero ? seoHeroImageUrl(glossaryHero) : \'\'');
    expect(source).toContain('<link rel="preload" as="image" fetchpriority="high" href="${generatedHeroUrl}">');
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
  // build-plugins/ogPagesPlugin.ts is now a 2-line colocation shim (issue
  // #4881 Fase 6) — the source text this test scrapes lives at the real,
  // relocated file under packages/articles/engine/.
  const ogSource = readFileSync(
    path.resolve(__dirname, '..', 'packages', 'articles', 'engine', 'ogPagesPlugin.ts'),
    'utf-8',
  );
  const staticSource = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

  it('staticPagesPlugin skip-set references the slugData of every ogPagesPlugin SECTION', () => {
    // Both ogPagesPlugin's `SECTIONS` and staticPagesPlugin's `ogSections`
    // used to be independent inline literals — this test originally scraped
    // the two source files and diffed the `slugData` string literals it found
    // in each. As of issue #4881 Fase 6 both derive from the SAME shared
    // `SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS` array
    // (build-plugins/shared/articleSectionDescriptors.ts),
    // so neither file contains a `slugData: '…'` literal to scrape anymore —
    // the invariant this test guards (staticPagesPlugin's skip-set covers
    // every section ogPagesPlugin owns) is now true BY CONSTRUCTION, not by
    // convention: both read the exact same array reference, so a section
    // omitted from one is omitted from both, never silently mismatched.
    expect(ogSource).toMatch(/from ['"]\.\/shared\/articleSectionDescriptors['"]/);
    expect(staticSource).toMatch(/from ['"]\.\/shared\/articleSectionDescriptors['"]/);
    expect(ogSource).toMatch(/SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS/);
    expect(staticSource).toMatch(/SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS\.map/);

    // Runtime-level guard on the shared array itself: still ≥2 article
    // sections (frontaliere + svizzera), each with a real slugData value —
    // if this ever went empty or lost a section, BOTH plugins would silently
    // lose skip-set coverage together (the exact failure mode this test
    // exists to catch), so pin it directly against the live data.
    const slugDataValues = SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS.map((sec) => sec.slugData);
    expect(slugDataValues).toContain('services/routerBlogData.ts');
    expect(slugDataValues).toContain('services/routerSwissData.ts');
    for (const sec of SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS) {
      expect(sec.slugData, `section "${sec.name}" must define a non-empty slugData`).toBeTruthy();
    }
  });

  // pesca un articolo reale dai registri services/seo/seo-blog-ch.ts e services/routerSwissData.ts, riscritti a ogni pubblicazione: rosso possibile senza cambi di codice
  it.skipIf(SKIP_LIVE_DATA)('skip-set parse derives all four locale paths for a svizzera article', () => {
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
