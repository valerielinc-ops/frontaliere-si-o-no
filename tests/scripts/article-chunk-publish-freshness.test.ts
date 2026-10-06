import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_SURFACE_PATHS,
  classifyPublishSource,
  isArticleSurfacePath,
  isCurrentPublishSource,
} from '../../scripts/lib/article-chunk-publish-freshness.mjs';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const WORKFLOW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/workflows/sync-articles-sitemaps.yml',
);

const SURFACE_PATHS = [
  ['article content glob', 'packages/articles/content/blog-body/it/x.ts'],
  ['news sitemap', 'public/sitemap-news.xml'],
  ['RSS glob', 'public/rss-it.xml'],
  ['news ticker', 'public/news-ticker-live.json'],
  ['workflow trigger', '.github/workflows/sync-articles-sitemaps.yml'],
] as const;

describe('article chunk publish freshness fence', () => {
  it('allows the checkout at the current main tip', () => {
    expect(isCurrentPublishSource(NEW_SHA, NEW_SHA)).toBe(true);
    expect(isCurrentPublishSource(NEW_SHA.toUpperCase(), NEW_SHA)).toBe(true);
  });

  it('flags an older checkout for refresh after main moves', () => {
    // This is the ordering the section lease alone cannot prevent: the new run
    // wins the lease first, then the old queued run acquires it afterwards.
    // The workflows use false as a signal to re-render origin/main, not to
    // silently skip the publish.
    expect(isCurrentPublishSource(OLD_SHA, NEW_SHA)).toBe(false);
  });

  it('classifies an unchanged tip as current', () => {
    expect(classifyPublishSource(NEW_SHA, NEW_SHA, [])).toBe('current');
  });

  it('classifies an advance with no article-surface changes as unrelated', () => {
    expect(classifyPublishSource(OLD_SHA, NEW_SHA, [])).toBe('unrelated-advance');
    expect(classifyPublishSource(OLD_SHA, NEW_SHA, ['README.md', 'scripts/lib/example.mjs'])).toBe(
      'unrelated-advance',
    );
  });

  for (const [label, changedPath] of SURFACE_PATHS) {
    it(`classifies ${label} changes as superseded`, () => {
      expect(classifyPublishSource(OLD_SHA, NEW_SHA, [changedPath])).toBe('superseded');
    });
  }

  it('matches the workflow path filter exactly, including its glob families', () => {
    const workflow = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
      on: { push: { paths: string[] } };
    };

    expect(workflow.on.push.paths).toEqual([...ARTICLE_SURFACE_PATHS]);
    expect(isArticleSurfacePath('public/rss-it.xml')).toBe(true);
    expect(isArticleSurfacePath('packages/articles/content/blog-body/it/x.ts')).toBe(true);
    expect(isArticleSurfacePath('public/rss-it.txt')).toBe(false);
    expect(isArticleSurfacePath('packages/articles/engine/index.mjs')).toBe(false);
  });

  it('fails closed when the changed path list is not available', () => {
    expect(() => classifyPublishSource(OLD_SHA, NEW_SHA, undefined)).toThrow(/changed paths/);
  });

  it('fails closed for malformed source or main SHAs', () => {
    expect(() => isCurrentPublishSource('old', NEW_SHA)).toThrow(/source SHA/);
    expect(() => isCurrentPublishSource(OLD_SHA, 'new')).toThrow(/main SHA/);
    expect(() => classifyPublishSource('old', NEW_SHA, [])).toThrow(/source SHA/);
    expect(() => classifyPublishSource(OLD_SHA, 'new', [])).toThrow(/main SHA/);
  });
});
