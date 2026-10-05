import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ARTICLE_SECTION_CORE,
  ARTICLE_SECTION_CORE_ALL,
  ARTICLE_SECTION_CORE_LIST,
  articleSectionKind,
  cantonHubTopicSlugs,
  isCantonSection,
  sectionsOfKind,
  twinOf,
} from '../../build-plugins/shared/articleSectionCore.mjs';
import { ARTICLE_SECTIONS, activeArticleSection } from '../../services/articleSections';
import { ARTICLE_SECTION_DESCRIPTORS } from '../../build-plugins/shared/articleSectionDescriptors';
import { BLOG_SECTION_RX } from '../../scripts/lib/articleSections.mjs';
import { RSS_SECTIONS, rssSectionFor } from '../../packages/articles/engine/rssFeeds.mjs';

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
        kind: 'frontaliere',
        shardKey: 'articolifrontaliere',
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
        kind: 'national',
        shardKey: 'articolisvizzera',
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

  it('ARTICLE_SECTION_CORE_ALL holds the 2 historical + 24 canton sections; the active map reuses the SAME entry objects', () => {
    const ids = Object.keys(ARTICLE_SECTION_CORE_ALL);
    expect(ids.slice(0, 2)).toEqual(['frontaliere', 'svizzera']);
    expect(ids).toHaveLength(26);
    expect(ids.slice(2).every((id) => /^canton-[a-z]+$/.test(id))).toBe(true);
    for (const [id, entry] of Object.entries(ARTICLE_SECTION_CORE)) {
      expect(entry, `${id} must be the ALL entry, not a copy`).toBe(ARTICLE_SECTION_CORE_ALL[id]);
    }
  });

  it('no canton section is active: every consumer that iterates the sections sees exactly frontaliere + svizzera', () => {
    expect(Object.keys(ARTICLE_SECTION_CORE)).toEqual(['frontaliere', 'svizzera']);
    expect(sectionsOfKind('canton')).toEqual([]);
    expect(sectionsOfKind('frontaliere')).toEqual([ARTICLE_SECTION_CORE.frontaliere]);
    expect(sectionsOfKind('national')).toEqual([ARTICLE_SECTION_CORE.svizzera]);
    expect(() => sectionsOfKind('regional' as never)).toThrow();
  });

  it('kind lookup and twin pairing are data, and fail loudly on an unknown id', () => {
    expect(articleSectionKind('frontaliere')).toBe('frontaliere');
    expect(articleSectionKind('svizzera')).toBe('national');
    expect(articleSectionKind('canton-ti')).toBe('canton');
    expect(() => articleSectionKind('canton-xx')).toThrow();
    expect(() => articleSectionKind('constructor')).toThrow();
    expect(isCantonSection('canton-basilea')).toBe(true);
    expect(isCantonSection('svizzera')).toBe(false);
    expect(isCantonSection('toString')).toBe(false);
    // The former ternary `section === 'frontaliere' ? 'svizzera' : 'frontaliere'`.
    expect(twinOf('frontaliere')).toBe('svizzera');
    expect(twinOf('svizzera')).toBe('frontaliere');
    expect(twinOf('canton-zh')).toBe('svizzera');
  });

  it('cantonHubTopicSlugs returns the 6 reserved hub slugs per locale (D2), canton sections only', () => {
    expect(cantonHubTopicSlugs('canton-ti', 'it')).toEqual(['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi']);
    expect(cantonHubTopicSlugs('canton-ti', 'en')).toEqual(['fuel', 'tax', 'mobility', 'events', 'pensions', 'services']);
    expect(cantonHubTopicSlugs('canton-zh', 'de')).toEqual(['treibstoff', 'steuern', 'mobilitaet', 'veranstaltungen', 'renten', 'dienstleistungen']);
    expect(cantonHubTopicSlugs('canton-ge', 'fr')).toEqual(['carburants', 'fiscalite', 'mobilite', 'evenements', 'retraites', 'services']);
    expect(() => cantonHubTopicSlugs('svizzera', 'it')).toThrow();
  });

  it('activeArticleSection resolves the active sections and refuses an inactive canton id', () => {
    expect(activeArticleSection('frontaliere')).toBe(ARTICLE_SECTION_CORE.frontaliere);
    expect(activeArticleSection('svizzera')).toBe(ARTICLE_SECTION_CORE.svizzera);
    expect(() => activeArticleSection('canton-ti')).toThrow(/non attiva/);
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
      expect(descriptor.kind).toBe(core.kind);
      expect(descriptor.shardKey).toBe(core.shardKey);
      expect(descriptor.bodyDir).toBe(core.bodyDir);
      expect(descriptor.metaPrefix).toBe(core.metaPrefix);
      expect(descriptor.registry).toBe(core.registryFile);
      expect(descriptor.slugData).toBe(core.slugDataFile);
      expect(descriptor.slugConst).toBe(core.slugConst);
      expect(descriptor.indexSlug).toEqual(core.indexSlug);
    }
  });

  it('articleSectionDescriptors.ts is derived from the ACTIVE core list and keeps the pre-table local fields', () => {
    // The kind-local fields are pinned to the two literals the module held
    // before it became table-driven: a value change here changes which files
    // renderArticlePages reads and which sitemap/canonical it writes.
    expect(ARTICLE_SECTION_DESCRIPTORS.map((s) => s.name)).toEqual(['frontaliere', 'svizzera']);
    const [frontaliere, svizzera] = ARTICLE_SECTION_DESCRIPTORS;
    expect(frontaliere.seoFiles).toEqual([
      'services/seo/seo-blog.ts',
      'services/seo/seo-blog-2.ts',
      'services/seo/seo-blog-3.ts',
      'services/seo/seo-blog-4.ts',
      'services/seo/seo-blog-5.ts',
      'services/seo/seo-blog-6.ts',
      'services/seo/seo-blog-7.ts',
      'services/seo/seo-blog-8.ts',
      'services/seo/seo-blog-9.ts',
      'services/seo/seo-blog-10.ts',
    ]);
    expect(frontaliere.canonicalPrefix).toBe('/articoli-frontaliere/');
    expect(frontaliere.sitemap).toBe('public/sitemap-blog.xml');
    expect(frontaliere.canonicalOverrides).toEqual([
      'packages/articles/engine/shared/frontaliere-article-canonical-overrides.json',
      'engine/shared/frontaliere-article-canonical-overrides.json',
    ]);
    expect(svizzera.seoFiles).toEqual(['services/seo/seo-blog-ch.ts']);
    expect(svizzera.canonicalPrefix).toBe('/articoli-svizzera/');
    expect(svizzera.sitemap).toBe('public/sitemap-blog-ch.xml');
    expect(svizzera.canonicalOverrides).toEqual([
      'data/swiss-article-canonical-overrides.json',
      'content/swiss-article-canonical-overrides.json',
    ]);
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
    // By value, on the imported table: RSS_SECTIONS is now BUILT from the
    // core list (one row per active section, looked up by kind), so the
    // former textual check for `ARTICLE_SECTION_CORE.<id>.<field>` literals no
    // longer describes how the table reads the tuple. The requirement it
    // pinned is kept twice over: every row's tuple fields equal the core's,
    // and the source must not restate any tuple value (a copy, not a read).
    expect(RSS_SECTIONS.map((s) => s.id)).toEqual(['frontaliere', 'svizzera']);
    for (const section of RSS_SECTIONS) {
      const core = ARTICLE_SECTION_CORE[section.id as 'frontaliere' | 'svizzera'];
      expect(section.slugFile).toBe(core.slugDataFile);
      expect(section.slugConst).toBe(core.slugConst);
      expect(section.bodyDir).toBe(core.bodyDir);
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(section.metaFile(locale)).toBe(`${core.metaPrefix}-${locale}.ts`);
        expect(section.localeMeta[locale].articlePrefix).toBe(
          locale === 'it' ? `/${core.indexSlug.it}/` : `/${locale}/${core.indexSlug[locale]}/`,
        );
      }
    }
    const source = readFileSync(
      path.resolve(rootDir, 'packages/articles/engine/rssFeeds.mjs'),
      'utf-8',
    );
    expect(source).toMatch(/from ['"]\.\/shared\/articleSectionCore\.mjs['"]/);
    for (const core of ARTICLE_SECTION_CORE_LIST) {
      for (const value of [core.slugDataFile, core.slugConst, core.metaPrefix, ...Object.values(core.indexSlug)]) {
        expect(source, `rssFeeds.mjs must read "${value}" from the core, not restate it`).not.toContain(`'${value}`);
      }
    }
  });

  it('rssFeeds.mjs RSS_SECTIONS keeps the pre-table feed files, fallbacks and channel copy', () => {
    // Pinned to the two hand-written rows the table replaced: the ten feed
    // files, their slug fallback and every channel title/description.
    const pinned = RSS_SECTIONS.map((s) => ({
      id: s.id,
      seoFiles: s.seoFiles,
      slugFallback: s.slugFallback,
      mainFeed: s.mainFeed,
      feeds: (['it', 'en', 'de', 'fr'] as const).map((l) => s.feedFile(l)),
      channel: Object.fromEntries(Object.entries(s.localeMeta).map(([l, m]: [string, any]) => [l, [m.title, m.description, m.language]])),
    }));
    expect(pinned).toEqual([
      {
        id: 'frontaliere',
        seoFiles: ['seo-blog.ts', 'seo-blog-2.ts', 'seo-blog-3.ts', 'seo-blog-4.ts', 'seo-blog-5.ts', 'seo-blog-6.ts', 'seo-blog-7.ts'],
        slugFallback: 'it',
        mainFeed: 'rss.xml',
        feeds: ['rss-it.xml', 'rss-en.xml', 'rss-de.xml', 'rss-fr.xml'],
        channel: {
          it: ['Frontaliere Ticino', 'Notizie e guide per frontalieri italiani in Ticino', 'it'],
          en: ['Frontaliere Ticino — English', 'News and guides for cross-border workers in Ticino', 'en'],
          de: ['Frontaliere Ticino — Deutsch', 'Nachrichten und Leitfaden für Grenzgänger im Tessin', 'de'],
          fr: ['Frontaliere Ticino — Français', 'Actualités et guides pour les frontaliers au Tessin', 'fr'],
        },
      },
      {
        id: 'svizzera',
        seoFiles: ['seo-blog-ch.ts'],
        slugFallback: 'id',
        mainFeed: 'rss-svizzera.xml',
        feeds: ['rss-svizzera-it.xml', 'rss-svizzera-en.xml', 'rss-svizzera-de.xml', 'rss-svizzera-fr.xml'],
        channel: {
          it: ['Frontaliere Ticino — Svizzera', 'Notizie e guide sulla Svizzera: economia, lavoro, fisco e vita quotidiana', 'it'],
          en: ['Frontaliere Ticino — Switzerland', 'News and guides about Switzerland: economy, work, taxes and daily life', 'en'],
          de: ['Frontaliere Ticino — Schweiz', 'Nachrichten und Leitfäden zur Schweiz: Wirtschaft, Arbeit, Steuern und Alltag', 'de'],
          fr: ['Frontaliere Ticino — Suisse', 'Actualités et guides sur la Suisse : économie, travail, fiscalité et vie quotidienne', 'fr'],
        },
      },
    ]);
  });

  it('rssFeeds.mjs gives every canton its own feed profile, never svizzera\'s (P7a)', () => {
    for (const entry of Object.values(ARTICLE_SECTION_CORE_ALL)) {
      if (entry.kind !== 'canton') continue;
      const row = rssSectionFor(entry);
      expect(row.id).toBe(entry.section);
      expect(row.seoFiles).toEqual([`seo-blog-${entry.section}.ts`]);
      expect(row.mainFeed).toBe(`rss-${entry.section}.xml`);
      expect(['it', 'en', 'de', 'fr'].map((l) => row.feedFile(l))).toEqual(
        ['it', 'en', 'de', 'fr'].map((l) => `rss-${entry.section}-${l}.xml`),
      );
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const meta = row.localeMeta[locale];
        expect(meta.articlePrefix).toBe(locale === 'it' ? `/${entry.indexSlug.it}/` : `/${locale}/${entry.indexSlug[locale]}/`);
        expect(meta.title).not.toMatch(/Svizzera|Switzerland|Schweiz|Suisse/);
      }
    }
  });

  it('rssFeeds.mjs refuses a section kind without a feed profile instead of inventing channel copy', () => {
    expect(() => rssSectionFor({ ...ARTICLE_SECTION_CORE_ALL['canton-ti'], kind: 'regione' } as never)).toThrow(/profilo RSS/);
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
