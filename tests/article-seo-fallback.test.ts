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

  it('cleans markdown-like article body sections before rendering', () => {
    const sections = cleanupArticleBodySections([
      '## Titolo\n**Testo** con [link](https://example.com) e `code`',
      undefined,
      '- punto uno\n- punto due',
    ]);

    expect(sections).toEqual([
      'Titolo\nTesto con link e code',
      '• punto uno\n• punto due',
    ]);
  });
});
