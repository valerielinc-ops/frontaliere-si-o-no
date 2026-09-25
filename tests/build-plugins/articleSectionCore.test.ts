import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_LIST } from '../../build-plugins/shared/articleSectionCore.mjs';
import { ARTICLE_SECTIONS } from '../../services/articleSections';
import { ARTICLE_SECTION_DESCRIPTORS } from '../../build-plugins/shared/articleSectionDescriptors';
import { BLOG_SECTION_RX } from '../../scripts/lib/articleSections.mjs';

const rootDir = path.resolve(__dirname, '..', '..');

/**
 * Pinning test for `build-plugins/shared/articleSectionCore.mjs` — the single
 * canonical source of the frontaliere/svizzera article-section descriptor
 * tuple (issue #4881 Fase 6, AGENTS.md #6). Before this module the same six
 * fields (indexSlug/bodyDir/metaPrefix/registryFile/slugDataFile/slugConst)
 * were hand-copied in six independent places (plus a seventh, the localized
 * hub-slug alternation in `scripts/lib/articleSections.mjs`). Any future edit
 * to the core values MUST show up as a diff in the literal object below —
 * that is the entire point of pinning it: a silent value change here is a
 * silent change to every one of the (now single-sourced) consumers.
 */
describe('ARTICLE_SECTION_CORE (canonical article-section registry)', () => {
  it('pins the full contents of the core registry', () => {
    expect(ARTICLE_SECTION_CORE).toEqual({
      frontaliere: {
        section: 'frontaliere',
        indexSlug: {
          it: 'articoli-frontaliere',
          en: 'cross-border-articles',
          de: 'grenzgaenger-artikel',
          fr: 'articles-frontalier',
        },
        bodyDir: 'blog-body',
        metaPrefix: 'blog-meta',
        registryFile: 'data/blog-articles-data.ts',
        slugDataFile: 'services/routerBlogData.ts',
        slugConst: 'BLOG_SLUGS',
      },
      svizzera: {
        section: 'svizzera',
        indexSlug: {
          it: 'articoli-svizzera',
          en: 'swiss-articles',
          de: 'schweiz-artikel',
          fr: 'articles-suisse',
        },
        bodyDir: 'blog-body-ch',
        metaPrefix: 'blog-meta-ch',
        registryFile: 'data/swiss-articles-data.ts',
        slugDataFile: 'services/routerSwissData.ts',
        slugConst: 'SWISS_SLUGS',
      },
    });
  });

  it('ARTICLE_SECTION_CORE_LIST is [frontaliere, svizzera] in that order', () => {
    expect(ARTICLE_SECTION_CORE_LIST).toEqual([
      ARTICLE_SECTION_CORE.frontaliere,
      ARTICLE_SECTION_CORE.svizzera,
    ]);
  });

  it('services/articleSections.ts re-exports the SAME object (reference equality, not a copy)', () => {
    // ARTICLE_SECTIONS is `ARTICLE_SECTION_CORE as unknown as …` — a type
    // cast, not a value transform — so this must be the identical reference,
    // the strongest possible proof the two never drift.
    expect(ARTICLE_SECTIONS).toBe(ARTICLE_SECTION_CORE);
  });

  it('articleSectionDescriptors.ts entries carry the core fields unchanged', () => {
    const byName = Object.fromEntries(ARTICLE_SECTION_DESCRIPTORS.map((s) => [s.name, s]));
    for (const id of ['frontaliere', 'svizzera'] as const) {
      const core = ARTICLE_SECTION_CORE[id];
      const descriptor = byName[id];
      expect(descriptor.bodyDir).toBe(core.bodyDir);
      expect(descriptor.metaPrefix).toBe(core.metaPrefix);
      expect(descriptor.registry).toBe(core.registryFile);
      expect(descriptor.slugData).toBe(core.slugDataFile);
      expect(descriptor.slugConst).toBe(core.slugConst);
      expect(descriptor.indexSlug).toEqual(core.indexSlug);
    }
  });

  it('scripts/create-article.mjs ARTICLE_SECTION_CONFIGS carries the core fields unchanged', async () => {
    const { ARTICLE_SECTION_CONFIGS } = await import('../../scripts/create-article.mjs');
    for (const id of ['frontaliere', 'svizzera'] as const) {
      const core = ARTICLE_SECTION_CORE[id];
      const cfg = ARTICLE_SECTION_CONFIGS[id];
      expect(cfg.hubSlug).toEqual(core.indexSlug);
      expect(cfg.registryFile).toBe(core.registryFile);
      expect(cfg.slugDataFile).toBe(core.slugDataFile);
      expect(cfg.slugsConstName).toBe(core.slugConst);
      expect(cfg.metaPrefix).toBe(core.metaPrefix);
      expect(cfg.bodyDir).toBe(core.bodyDir);
    }
  });

  it('packages/articles/engine/rssFeeds.mjs RSS_SECTIONS carries the core fields unchanged', () => {
    // Statically, not by import: the module is cheap to import, but reading the
    // source is what actually pins the requirement — the table must READ the
    // shared tuple rather than restate the values, and only the source shows
    // that. (Before #4974 item 2 this logic lived in
    // `scripts/generate-rss-feeds.mjs`, which additionally could not be
    // imported at all: its `main()` ran at module top level, wrote real files
    // under `public/`, and called `process.exit()`.)
    const source = readFileSync(
      path.resolve(rootDir, 'packages/articles/engine/rssFeeds.mjs'),
      'utf-8',
    );
    expect(source).toMatch(/from ['"]\.\/shared\/articleSectionCore\.mjs['"]/);
    for (const id of ['frontaliere', 'svizzera'] as const) {
      for (const field of ['slugDataFile', 'metaPrefix', 'bodyDir', 'indexSlug'] as const) {
        expect(
          source,
          `rssFeeds.mjs must reference ARTICLE_SECTION_CORE.${id}.${field}`,
        ).toContain(`ARTICLE_SECTION_CORE.${id}.${field}`);
      }
    }
    // The values themselves are pinned above (ARTICLE_SECTION_CORE test).
    // Equivalence was confirmed separately when this logic moved: the module
    // regenerated all 10 public/rss*.xml with `git status` reporting zero diff,
    // and the articles repo's publisher — calling this same module with its own
    // layout — produced those ten files byte-identical (`cmp`) to the site's.
    // Not re-run here: the feeds are now pulled from the published API
    // (scripts/pull-articles-api.mjs), and a unit test must not rewrite tracked
    // files as a side effect.
  });

  it('scripts/schedule-fb-articles-daily.mjs SECTIONS carries the core fields unchanged', async () => {
    const { SECTIONS } = await import('../../scripts/schedule-fb-articles-daily.mjs');
    const byId = Object.fromEntries(SECTIONS.map((s: any) => [s.section, s]));
    for (const id of ['frontaliere', 'svizzera'] as const) {
      const core = ARTICLE_SECTION_CORE[id];
      const sec = byId[id];
      expect(sec.registry).toBe(core.registryFile);
      expect(sec.slugFile).toBe(core.slugDataFile);
      expect(sec.metaFile).toBe(`services/locales/${core.metaPrefix}-it.ts`);
    }
  });

  it('scripts/lib/articleSections.mjs BLOG_SECTION_RX matches every core hub slug (all sections, all locales)', () => {
    for (const entry of ARTICLE_SECTION_CORE_LIST) {
      for (const slug of Object.values(entry.indexSlug)) {
        expect(BLOG_SECTION_RX.test(`/${slug}/`), `hub slug "${slug}" must match BLOG_SECTION_RX`).toBe(true);
      }
    }
  });
});
