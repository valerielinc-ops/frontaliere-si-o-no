import { describe, expect, it } from 'vitest';
import type { BlogArticleId } from '@/packages/articles/content/blogArticleIds';
import { ALL_BLOG_ARTICLE_IDS } from '@/packages/articles/content/routerBlogData';

describe('blog article id registry', () => {
  it('keeps the Locate Varesino article in the typed and runtime registries', () => {
    const articleId: BlogArticleId = 'caduta-scala-locate-varesino';

    expect(ALL_BLOG_ARTICLE_IDS).toContain(articleId);
  });
});
