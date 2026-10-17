import { describe, expect, it } from 'vitest';

import {
  hasArticleBodyPromptPlaceholder,
  isArticleBodyPromptPlaceholder,
} from '../packages/articles/engine/shared/articleBodyQuality';

describe('article body prompt-placeholder guard', () => {
  it('recognizes the exact and generator-suffixed corpus markers', () => {
    expect(isArticleBodyPromptPlaceholder('...')).toBe(true);
    expect(isArticleBodyPromptPlaceholder('....')).toBe(true);
    expect(isArticleBodyPromptPlaceholder('...\n\n## Recommended tools')).toBe(true);
    expect(hasArticleBodyPromptPlaceholder({ body1: 'real prose', body2: '...\n\n## Tools' })).toBe(true);
  });

  it('does not classify ordinary prose or non-body fields', () => {
    expect(isArticleBodyPromptPlaceholder('... real prose on the same line')).toBe(false);
    expect(isArticleBodyPromptPlaceholder('A sentence ending in ...')).toBe(false);
    expect(hasArticleBodyPromptPlaceholder({ title: '...', faq: '...' })).toBe(false);
    expect(hasArticleBodyPromptPlaceholder({ body1: 'real prose\n\n...' })).toBe(false);
  });
});
