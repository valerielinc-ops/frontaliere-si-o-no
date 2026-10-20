import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const allSiteSources = [
  ...sourceFiles(path.join(root, 'build-plugins')),
  ...sourceFiles(path.join(root, 'packages', 'articles', 'engine')),
  ...sourceFiles(path.join(root, 'scripts')),
];

const activeListOwners = new Set([
  'packages/articles/engine/shared/articleSectionCore.mjs',
  'packages/articles/engine/shared/articleSectionDescriptors.ts',
  'packages/articles/engine/rssFeeds.mjs',
  // The build-plugin paths are symlinks to the shared engine sources in a
  // normal site checkout, but the scan reports the path it walked.
  'build-plugins/shared/articleSectionCore.mjs',
  'build-plugins/shared/articleSectionDescriptors.ts',
]);

const staticSelectorContracts = {
  'build-plugins/staticPagesPlugin.ts': 'SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS',
  'build-plugins/topicClusterHubsData.ts': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'build-plugins/topicClusterHubsPlugin.ts': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'build-plugins/shared/articleRedirects.mjs': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'scripts/lib/articleSections.mjs': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'scripts/lib/article-slug-registry.mjs': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'scripts/ci/check-orphan-article-meta.mjs': 'SITE_RENDERED_ARTICLE_SECTIONS',
  'scripts/manage-article.mjs': 'SITE_RENDERED_ARTICLE_SECTIONS',
} as const;

function relative(file: string): string {
  return path.relative(root, file);
}

describe('site-rendered article-section boundary', () => {
  it('keeps active-list iteration confined to the core/publisher projections', () => {
    const violations = allSiteSources
      .filter((file) => /\bARTICLE_SECTION_CORE_LIST\b/.test(readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !activeListOwners.has(file));

    expect(
      violations,
      'A site module is iterating ARTICLE_SECTION_CORE_LIST. Use the explicit site-rendered selector for static output; keep active iteration only in the core, descriptor projection, or corpus RSS publisher.',
    ).toEqual([]);
  });

  it('pins every known static-site iterator to the explicit selector', () => {
    for (const [file, selector] of Object.entries(staticSelectorContracts)) {
      const source = readFileSync(path.join(root, file), 'utf8');
      expect(source, `${file} must import/use ${selector}`).toContain(selector);
    }
  });

  it('keeps the site article-page closeBundle loop on the site projection', () => {
    const source = readFileSync(
      path.join(root, 'packages', 'articles', 'engine', 'ogPagesPlugin.ts'),
      'utf8',
    );
    expect(source).toMatch(/for \(const descriptor of SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS\)/);
  });

  it('keeps the shared RSS API explicit about the corpus default and site override', () => {
    const source = readFileSync(
      path.join(root, 'packages', 'articles', 'engine', 'rssFeeds.mjs'),
      'utf8',
    );
    expect(source).toContain('export const RSS_SECTIONS = [];');
    expect(source).toContain('registerActiveArticleSections(refreshRssSections);');
    expect(source).toContain('export const SITE_RSS_SECTIONS = SITE_RENDERED_ARTICLE_SECTIONS.map(rssSectionFor);');
    expect(source).toContain('sections = RSS_SECTIONS');
  });
});
