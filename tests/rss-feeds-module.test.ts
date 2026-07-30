import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildAllRssFeeds, buildSectionFeeds, RSS_SECTIONS, RSS_MAX_ITEMS } from '../packages/articles/engine/rssFeeds.mjs';

/**
 * Gate for the RSS generator after it moved out of `scripts/generate-rss-feeds.mjs`
 * into the articles package (issue #4974 item 2), where BOTH this site and the
 * articles repository's publisher call it.
 *
 * What matters here is the two things the move actually changed:
 *   1. the corpus location is a parameter (`layout`), so the publisher can point
 *      at `content/` while the site keeps pointing at `services/locales`;
 *   2. `media:content` is resolved from the article registry instead of probing
 *      `public/images/**` — a filesystem the publisher does not have.
 * Everything else must keep emitting the same shape, which is why the fixture
 * asserts on the rendered XML rather than on intermediate structures.
 */

const LAYOUT = { seoDir: 'seo', localesDir: 'locales' };

/** Minimal on-disk corpus in the shape the readers parse. */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-feeds-'));
  const section = RSS_SECTIONS[0]; // frontaliere

  fs.mkdirSync(path.join(root, 'seo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'seo', section.seoFiles[0]),
    `export const BLOG_SEO_METADATA = {
  'blog-alpha': {
    structuredData: { "headline": "Alpha headline", "description": "Alpha description", "datePublished": "2026-03-02", "articleSection": "Fiscale" },
  },
  'blog-beta': {
    structuredData: { "headline": "Beta headline", "description": "Beta description", "datePublished": "2026-03-01", "articleSection": "Pratico" },
  },
};
`,
  );

  // Slug map — `slugFile` is repo-relative and NOT part of `layout`, so the
  // fixture writes it at exactly the path the section descriptor names.
  const slugFile = path.join(root, section.slugFile);
  fs.mkdirSync(path.dirname(slugFile), { recursive: true });
  fs.writeFileSync(
    slugFile,
    `const BLOG_SLUGS = {
  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },
  'beta': { it: 'beta-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },
};
`,
  );

  fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    fs.writeFileSync(
      path.join(root, 'locales', section.metaFile(locale)),
      `const meta = {
 'blog.article.alpha.title': 'Alpha ${locale}',
 'blog.article.alpha.excerpt': 'Alpha excerpt ${locale}',
 'blog.article.beta.title': 'Beta ${locale}',
 'blog.article.beta.excerpt': 'Beta excerpt ${locale}',
};
`,
    );
    const bodyDir = path.join(root, 'locales', section.bodyDir, locale);
    fs.mkdirSync(bodyDir, { recursive: true });
    fs.writeFileSync(
      path.join(bodyDir, 'alpha.ts'),
      'export default { ' +
        "'blog.article.alpha.body1': `Alpha body text in " +
        locale +
        ', long enough to clear the fifty character minimum.` };\n',
    );
  }

  return root;
}

const REGISTRY = [
  { id: 'alpha', image: 'https://cdn.frontaliereticino.ch/images/blog/alpha.webp' },
  { id: 'beta', image: '/images/places/beta.webp' },
];

describe('packages/articles/engine/rssFeeds', () => {
  it('reads the corpus from the layout it is given, not a hardcoded site path', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });

    expect(section.id).toBe('frontaliere');
    expect(section.articleCount).toBe(2);
    expect(section.slugCount).toBe(2);
    // 4 locales + the main feed copy.
    expect(section.feeds.map(([name]) => name)).toEqual([
      'rss-it.xml',
      'rss.xml',
      'rss-en.xml',
      'rss-de.xml',
      'rss-fr.xml',
    ]);
  });

  it('re-parents the slug module via slugDir (the publisher keeps it under content/)', () => {
    const root = makeFixture();
    const section = RSS_SECTIONS[0];
    // Move the slug file from the site path (`services/routerBlogData.ts`) to a
    // flat `corpus/` dir — exactly the reshaping the articles repo needs.
    const from = path.join(root, section.slugFile);
    const to = path.join(root, 'corpus', path.basename(section.slugFile));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);

    // Without slugDir the slug map is unreachable → slugs fall back to article ids.
    const blind = buildSectionFeeds({
      fs, path, rootDir: root, section, registry: REGISTRY, layout: LAYOUT,
    });
    expect(blind.slugCount).toBe(0);
    expect(blind.feeds.find(([n]) => n === 'rss-it.xml')![1]).toContain(
      '<link>https://frontaliereticino.ch/articoli-frontaliere/alpha/</link>',
    );

    const located = buildSectionFeeds({
      fs, path, rootDir: root, section, registry: REGISTRY,
      layout: { ...LAYOUT, slugDir: 'corpus' },
    });
    expect(located.slugCount).toBe(2);
    expect(located.feeds.find(([n]) => n === 'rss-it.xml')![1]).toContain(
      '<link>https://frontaliereticino.ch/articoli-frontaliere/alpha-it/</link>',
    );
  });

  it('emits nothing for a section whose seo chunks are absent, instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-empty-'));
    const result = buildSectionFeeds({
      fs,
      path,
      rootDir: root,
      section: RSS_SECTIONS[0],
      registry: REGISTRY,
      layout: LAYOUT,
    });
    expect(result.articleCount).toBe(0);
    expect(result.feeds).toEqual([]);
  });

  it('resolves media:content from the registry, absolutising origin-relative images', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];

    // Already-absolute CDN URL passes through untouched.
    expect(it).toContain(
      '<media:content url="https://cdn.frontaliereticino.ch/images/blog/alpha.webp" medium="image"/>',
    );
    // `/images/places/*` is NOT CDN-offloaded and must be served from origin —
    // the filesystem probe this replaced did exactly that.
    expect(it).toContain(
      '<media:content url="https://frontaliereticino.ch/images/places/beta.webp" medium="image"/>',
    );
  });

  it('falls back to the app icon when the registry has no image for an article', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: [] },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];
    expect(it).toContain(
      '<media:content url="https://frontaliereticino.ch/icons/icon-512x512.png" medium="image"/>',
    );
  });

  it('renders localized titles, excerpts, bodies and trailing-slash article links', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const de = section.feeds.find(([name]) => name === 'rss-de.xml')![1];

    expect(de).toContain('<title>Alpha de</title>');
    expect(de).toContain('<![CDATA[Alpha excerpt de]]>');
    expect(de).toContain('<content:encoded><![CDATA[Alpha body text');
    // Localized slug + localized section prefix, trailing slash (site convention).
    expect(de).toContain('<link>https://frontaliereticino.ch/de/grenzgaenger-artikel/alpha-de/</link>');
    expect(de).toContain(
      '<guid isPermaLink="true">https://frontaliereticino.ch/de/grenzgaenger-artikel/alpha-de/</guid>',
    );
    // Category comes from the seo chunk's articleSection.
    expect(de).toContain('<category>Fiscale</category>');
    // Newest first.
    expect(de.indexOf('Alpha de')).toBeLessThan(de.indexOf('Beta de'));
  });

  it('makes the main feed a byte copy of the Italian one, self-linking to the main filename', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];
    const main = section.feeds.find(([name]) => name === 'rss.xml')![1];

    expect(main).toBe(it);
    expect(main).toContain(
      '<atom:link href="https://frontaliereticino.ch/rss.xml" rel="self" type="application/rss+xml"/>',
    );
  });

  it('caps each feed at RSS_MAX_ITEMS', () => {
    const root = makeFixture();
    const section = RSS_SECTIONS[0];
    // Overwrite the seo chunk with more entries than the cap allows.
    const entries = Array.from({ length: RSS_MAX_ITEMS + 10 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return `  'blog-art${i}': { structuredData: { "headline": "H${i}", "description": "D${i}", "datePublished": "2026-03-${day}", "articleSection": "Notizie" } },`;
    }).join('\n');
    fs.writeFileSync(
      path.join(root, 'seo', section.seoFiles[0]),
      `export const BLOG_SEO_METADATA = {\n${entries}\n};\n`,
    );

    const result = buildSectionFeeds({
      fs,
      path,
      rootDir: root,
      section,
      registry: REGISTRY,
      layout: LAYOUT,
    });
    const it = result.feeds.find(([name]) => name === 'rss-it.xml')![1];
    expect((it.match(/<item>/g) ?? []).length).toBe(RSS_MAX_ITEMS);
  });
});

/**
 * The feed must read the chunk new articles are actually written to.
 *
 * `seoFiles` was `['seo-blog.ts', 'seo-blog-2.ts']`, on the reasoning that the
 * feed "only needs the freshest chunks". That stopped being true when
 * create-article started appending to `seo-blog-5.ts` (its `SECTION.seoFile`):
 * the two chunks the feed read stopped receiving articles, and since they are
 * the sole source of the item list, the feed froze. Measured when found: the
 * live rss.xml's newest item was 3 May while the corpus published daily into
 * July — three months invisible to subscribers, and nothing failed, because a
 * feed that stops updating still serves 200.
 *
 * So the guard is not "read these files" but "read wherever the generator
 * writes", checked against the generator's own configuration.
 */
describe('RSS reads the chunk create-article writes to (#4974)', () => {
  it('covers the section seoFile create-article appends new articles to', () => {
    const createArticle = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'create-article.mjs'),
      'utf-8',
    );
    const written = [...createArticle.matchAll(/seoFile:\s*'services\/seo\/([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(written.length, 'no seoFile found in create-article.mjs').toBeGreaterThan(0);

    for (const section of RSS_SECTIONS) {
      const covered = written.filter((f) => section.seoFiles.includes(f));
      expect(
        covered.length,
        `section '${section.id}' reads ${JSON.stringify(section.seoFiles)} but new articles ` +
          `go to one of ${JSON.stringify(written)} — a feed that does not read the chunk ` +
          `being written to silently stops updating`,
      ).toBeGreaterThan(0);
    }
  });
});
