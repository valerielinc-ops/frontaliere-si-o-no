import { describe, expect, it } from 'vitest';

import {
  hasArticleBodyPromptPlaceholder,
  isArticleBodyPromptPlaceholder,
} from '../packages/articles/engine/shared/articleBodyQuality';
import miazzinaFrenchBody from '../packages/articles/content/blog-body/fr/miazzina-pendolare-fisco-ticino';

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

  it('keeps the Miazzina French sections substantive and free of prompt placeholders', () => {
    const body = {
      body1: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body1'],
      body2: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body2'],
      body3: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body3'],
    };

    expect(hasArticleBodyPromptPlaceholder(body)).toBe(false);
    expect(body.body2.trim().split(/\s+/).length).toBeGreaterThan(50);
    expect(body.body3.trim().split(/\s+/).length).toBeGreaterThan(50);
    expect(body.body2).toContain('nav:exchange');
    expect(body.body2).toContain('nav:banks');
    expect(body.body3).toContain('nav:payslip');
  });
});
