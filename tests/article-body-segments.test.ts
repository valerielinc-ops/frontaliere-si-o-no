import { describe, expect, it } from 'vitest';
import { collectArticleBodySegments } from '@/services/articleBodySegments';

describe('article body segment ordering', () => {
  it('keeps later published body keys visible when an optional body number is absent', () => {
    const translations: Record<string, string> = {
      'blog.article.sparse-body.body1': 'Intro.',
      'blog.article.sparse-body.body2': 'Secondo.',
      'blog.article.sparse-body.body3': 'Terzo.',
      'blog.article.sparse-body.body5': 'Quinto.',
    };

    expect(collectArticleBodySegments('sparse-body', (key) => translations[key] ?? key)).toEqual([
      'Intro.',
      'Secondo.',
      'Terzo.',
      'Quinto.',
    ]);
  });
});
