import { describe, expect, it, vi } from 'vitest';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const PILOT = ['canton-be', 'canton-gr', 'canton-ti'];

/**
 * Load the static-site surface projection with a mocked activation list. This
 * follows the canton-section tests' isolation pattern: the active list changes
 * between the two imports, while the assertion only observes site emitters.
 */
async function staticProjection(activeCantons: string[]) {
  vi.resetModules();
  vi.doMock('../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs', async () => {
    const actual = await vi.importActual<typeof import('../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs')>(
      '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs',
    );
    return { ...actual, ACTIVE_CANTON_SECTIONS: activeCantons };
  });

  const [core, descriptors, rss, redirects, slugRegistry, articleSections, topicData] = await Promise.all([
    import('../packages/articles/engine/shared/articleSectionCore.mjs'),
    import('../packages/articles/engine/shared/articleSectionDescriptors.ts'),
    import('../packages/articles/engine/rssFeeds.mjs'),
    import('../build-plugins/shared/articleRedirects.mjs'),
    import('../scripts/lib/article-slug-registry.mjs'),
    import('../scripts/lib/articleSections.mjs'),
    import('../build-plugins/topicClusterHubsData.ts'),
  ]);

  const topicSections = [...topicData.TOPIC_HUB_SECTIONS];
  const topicIndexPaths = topicSections.flatMap((section) =>
    LOCALES.map((locale) => topicData.buildTopicIndexPath(locale, section)),
  ).sort();
  return {
    core: core.SITE_RENDERED_ARTICLE_SECTIONS.map(({ section, kind, shardKey, indexSlug }) => ({ section, kind, shardKey, indexSlug })),
    descriptors: descriptors.SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS.map(({ name, kind, shardKey, seoFiles, canonicalPrefix, sitemap, bodyDir, metaPrefix, registry, slugData, slugConst, indexSlug }) => ({
      name, kind, shardKey, seoFiles, canonicalPrefix, sitemap, bodyDir, metaPrefix, registry, slugData, slugConst, indexSlug,
    })),
    rss: rss.SITE_RSS_SECTIONS.map((section) => ({
      id: section.id,
      seoFiles: section.seoFiles,
      slugFile: section.slugFile,
      slugConst: section.slugConst,
      bodyDir: section.bodyDir,
      mainFeed: section.mainFeed,
      feeds: LOCALES.map((locale) => section.feedFile(locale)),
    })),
    redirectPrefixes: [...redirects.articleSectionPrefixes()].map(([prefix, value]) => [prefix, value]),
    articleSectionKeys: slugRegistry.ARTICLE_SECTION_KEYS,
    articlePathBase: slugRegistry.ARTICLE_PATH_BASE,
    articleRegistryFiles: slugRegistry.ARTICLE_REGISTRY_FILES,
    blogSectionRegex: articleSections.BLOG_SECTION_RX.source,
    topicSections,
    topicIndexPaths,
    topicIndexCanonicalPaths: [...topicData.TOPIC_INDEX_CANONICAL_PATHS].sort(),
    topicHubCanonicalPaths: [...topicData.TOPIC_HUB_CANONICAL_PATHS].sort(),
    topicSitemaps: topicSections.map((section) => topicData.topicSitemapPathname(section)),
  };
}

describe('site static output is independent of active canton activation', () => {
  it('is identical with TI/GR/BE active and with no canton active', async () => {
    const empty = await staticProjection([]);
    const pilot = await staticProjection(PILOT);
    expect(pilot).toEqual(empty);
    expect(JSON.stringify(pilot)).toBe(JSON.stringify(empty));
  });
});
