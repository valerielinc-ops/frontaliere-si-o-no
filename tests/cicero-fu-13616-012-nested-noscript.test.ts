import { describe, expect, it } from 'vitest';
import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

describe('nested noscript fallback contract (#13616 FU-012)', () => {
  it('keeps top-level editorial paragraphs while excluding nested tracking content', () => {
    const first = 'The first editorial fallback paragraph contains enough source context to be retained.';
    const tracking = 'Nested tracking payload is deliberately long enough to pass a paragraph floor but must be rejected.';
    const second = 'The second editorial fallback paragraph remains in document order after the tracking wrapper.';
    const html = '<article><noscript>'
      + `<p>${first}</p><div data-track-pixel="1"><noscript><p>${tracking}</p></noscript></div>`
      + `<p>${second}</p></noscript></article>`;

    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).toBe(`${first}\n\n${second}`);
    expect(result.text).not.toContain(tracking);
  });

  it('does not let nested fallback JSON-LD outrank an editorial top-level block', () => {
    const articleBody = 'Nested tracking JSON-LD must not become the selected article source. '.repeat(8);
    const editorial = 'Top-level editorial prose remains the usable fallback when nested metadata is tracking-marked.';
    const html = '<main><noscript><div data-track-pixel="1">'
      + `<script type="application/ld+json">${JSON.stringify({ articleBody })}</script>`
      + `</div><p>${editorial}</p></noscript></main>`;

    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain(articleBody);
    expect(result.text).toContain(editorial);
  });
});
