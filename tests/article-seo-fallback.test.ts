import { describe, expect, it } from 'vitest';

import { buildArticleSeoSections, cleanupArticleBodySections } from '@/build-plugins/articleSeoFallback';

const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

describe('article SEO fallback builder', () => {
  it('builds rich Italian fallback sections with enough semantic depth', () => {
    const sections = buildArticleSeoSections(
      'it',
      'Telelavoro frontalieri: cosa cambia nel 2026',
      'Accordo aggiornato tra Italia e Svizzera sul telelavoro dei frontalieri.',
      'telelavoro frontalieri, accordo italia svizzera, imposta alla fonte, lavoro ticino',
    );

    expect(sections).toHaveLength(5);
    expect(sections.every((section) => section.paragraphs.length >= 1)).toBe(true);

    const allText = sections.flatMap((section) => [section.heading, ...section.paragraphs]).join(' ');
    expect(wordCount(allText)).toBeGreaterThan(320);
    expect(allText).toContain('telelavoro');
    expect(allText).toContain('imposta');
  });

  it('renders markdown-like article body sections into semantic HTML', () => {
    const sections = cleanupArticleBodySections([
      '## Titolo\n**Testo** con [link](https://example.com) e `code`',
      undefined,
      '- punto uno\n- punto due',
    ]);

    expect(sections).toEqual([
      '<h3>Titolo</h3><p><strong>Testo</strong> con <a href="https://example.com">link</a> e <code>code</code></p>',
      '<ul><li>punto uno</li><li>punto due</li></ul>',
    ]);
  });

  it('escapes HTML-special characters in body markdown before adding markup', () => {
    const sections = cleanupArticleBodySections(['Tom & Jerry <script>alert(1)</script>']);

    expect(sections).toEqual(['<p>Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;</p>']);
  });

  it('renders single-# headings (used by some articles) as h3, not literal text', () => {
    const sections = cleanupArticleBodySections(['# Titolo principale\nTesto del paragrafo.']);

    expect(sections).toEqual(['<h3>Titolo principale</h3><p>Testo del paragrafo.</p>']);
  });
});
