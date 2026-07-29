/**
 * Guards the invariant broken in production on 2026-07-29 (#4881).
 *
 * `publish-article-chunks.mjs` pushes the article registry to the CDN out of
 * band, ahead of the next full deploy. The titles the client renders come from
 * the `blog-meta-*` translation chunks and the URLs it links to come from the
 * router slug maps. Before this script existed all three shipped in the same
 * deploy and could not disagree.
 *
 * Publishing only the registry broke that: the live list gained articles whose
 * translations and slugs were still the previous build's, so
 * `/articoli-svizzera/` rendered raw `blog.article.<id>.title` keys and links
 * that resolved nowhere.
 *
 * Two properties are locked here — the second is the one that actually
 * prevents a recurrence, since a correct set published in the wrong order
 * still leaves a window where the list names articles the client cannot
 * translate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANION_CHUNKS, REGISTRIES } from '../../scripts/publish-article-chunks.mjs';

const ROOT = resolve(__dirname, '..', '..');
const src = readFileSync(resolve(ROOT, 'scripts/publish-article-chunks.mjs'), 'utf-8');

/**
 * Pre-existing debt, NOT caused by the companion-publish fix: these three ids
 * are in the registry and have slugs and live pages, but carry no
 * `blog.article.<id>.*` entry in ANY of the eight locale tables. They render
 * raw keys in the article list today and would keep doing so after a full
 * deploy, so the companion publish cannot help them — the translations simply
 * do not exist.
 *
 * Recorded as a ratchet rather than silently excluded: NEW offenders still
 * fail this test. Tracked separately for content repair; shrink this set as
 * they are fixed, never grow it.
 */
const KNOWN_UNTRANSLATED = new Set([
  'permesso-g-pro-contro-2026',
  'cantieri-traffico-a9-ticino',
  'iniziativa-salari-ticino',
]);

describe('publish-article-chunks — registry never ships ahead of its translations', () => {
  it('covers every translation table and both slug maps', () => {
    const keys = COMPANION_CHUNKS.map((c) => c.cdnKey).sort();
    expect(keys).toEqual(
      [
        ...['it', 'en', 'de', 'fr'].flatMap((l) => [`assets/blog-meta-${l}.js`, `assets/blog-meta-ch-${l}.js`]),
        'assets/routerBlogData.js',
        'assets/routerSwissData.js',
      ].sort(),
    );
  });

  it('publishes companions BEFORE the registries', () => {
    // Order is the fix, not an optimisation: companions-first fails safe (the
    // client holds translations for articles it cannot see yet — invisible),
    // registries-first fails exactly the way production did.
    const companionLoop = src.indexOf('for (const companion of COMPANION_CHUNKS)');
    const registryLoop = src.indexOf('for (const registry of REGISTRIES)');
    expect(companionLoop).toBeGreaterThan(-1);
    expect(registryLoop).toBeGreaterThan(-1);
    expect(companionLoop).toBeLessThan(registryLoop);
  });

  it('every registry article id has a translated title and a slug entry', () => {
    // The source-level version of the invariant that broke at the CDN layer.
    const idsOf = (rel: string) =>
      [...readFileSync(resolve(ROOT, rel), 'utf-8').matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]);
    const cases = [
      ...['it', 'en', 'de', 'fr'].map((loc) => ({
        registry: 'data/blog-articles-data.ts',
        meta: `services/locales/blog-meta-${loc}.ts`,
        slugs: 'services/routerBlogData.ts',
      })),
      ...['it', 'en', 'de', 'fr'].map((loc) => ({
        registry: 'data/swiss-articles-data.ts',
        meta: `services/locales/blog-meta-ch-${loc}.ts`,
        slugs: 'services/routerSwissData.ts',
      })),
    ];
    for (const c of cases) {
      const meta = readFileSync(resolve(ROOT, c.meta), 'utf-8');
      const slugs = readFileSync(resolve(ROOT, c.slugs), 'utf-8');
      const missingTitle = idsOf(c.registry)
        .filter((id) => !meta.includes(`'blog.article.${id}.title'`))
        .filter((id) => !KNOWN_UNTRANSLATED.has(id));
      const missingSlug = idsOf(c.registry).filter((id) => !slugs.includes(`'${id}':`));
      expect(missingTitle, `${c.registry}: NEW ids with no title in ${c.meta}`).toEqual([]);
      expect(missingSlug, `${c.registry}: ids with no slug in ${c.slugs}`).toEqual([]);
    }
  });

  it('REGISTRIES still covers both sections', () => {
    expect(REGISTRIES.map((r) => r.exportName).sort()).toEqual(['ARTICLES', 'SWISS_ARTICLES']);
  });
});
