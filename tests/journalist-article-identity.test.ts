import { beforeEach, describe, expect, it, vi } from 'vitest';

const readSlugRegistry = vi.hoisted(() => vi.fn());

vi.mock('../scripts/lib/article-slug-registry.mjs', () => ({
  ARTICLE_REGISTRY_FILES: {
    frontaliere: { file: 'services/routerBlogData.ts', constName: 'BLOG_SLUGS' },
    svizzera: { file: 'services/routerSwissData.ts', constName: 'SWISS_SLUGS' },
  },
  readSlugRegistry,
}));

import {
  getAllArticleIds,
  invalidateArticleIdCache,
} from '../scripts/lib/journalist-article-identity.mjs';

describe('journalist article identity registry reads', () => {
  beforeEach(() => {
    invalidateArticleIdCache();
    readSlugRegistry.mockReset();
  });

  it('propagates a malformed routerBlogData.ts parser error', () => {
    const parseError = new SyntaxError('malformed services/routerBlogData.ts');
    readSlugRegistry.mockImplementationOnce(() => {
      throw parseError;
    });

    expect(() => getAllArticleIds()).toThrow(parseError);
    expect(readSlugRegistry).toHaveBeenCalledWith(expect.any(URL), 'BLOG_SLUGS');
  });
});
