import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderFormattedContent } from '@/components/community/BlogArticles';

describe('article inline link markup', () => {
  it('renders emphasis inside external and relative links instead of exposing markers', () => {
    const html = renderToStaticMarkup(renderFormattedContent(
      'Consulta [**la riforma**](https://example.com) e [*la guida*](/guida/).',
    ));

    expect(html).toMatch(/<a href="https:\/\/example\.com"[^>]*><strong[^>]*>la riforma<\/strong><\/a>/);
    expect(html).toMatch(/<a href="\/guida\/"[^>]*><em[^>]*>la guida<\/em><\/a>/);
    expect(html).not.toContain('**la riforma**');
    expect(html).not.toContain('*la guida*');
  });
});
