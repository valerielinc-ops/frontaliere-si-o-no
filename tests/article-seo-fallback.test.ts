import { describe, expect, it } from 'vitest';

import { buildArticleSeoSections, cleanupArticleBodySections } from '@/build-plugins/articleSeoFallback';

const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

const keyed = (texts: Array<string | undefined>) =>
  texts.map((text, i) => ({ key: `body${i + 1}`, text }));

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
    const sections = cleanupArticleBodySections(keyed([
      '## Titolo\n**Testo** con [link](https://example.com) e `code`',
      undefined,
      '- punto uno\n- punto due',
    ]));

    expect(sections.map((s) => s.html)).toEqual([
      '<h3>Titolo</h3><p><strong>Testo</strong> con <a href="https://example.com">link</a> e <code>code</code></p>',
      '<ul><li>punto uno</li><li>punto due</li></ul>',
    ]);
  });

  it('escapes HTML-special characters in body markdown before adding markup', () => {
    const sections = cleanupArticleBodySections(keyed(['Tom & Jerry <script>alert(1)</script>']));

    expect(sections.map((s) => s.html)).toEqual(['<p>Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;</p>']);
  });

  it('renders single-# headings (used by some articles) as h3, not literal text', () => {
    const sections = cleanupArticleBodySections(keyed(['# Titolo principale\nTesto del paragrafo.']));

    expect(sections.map((s) => s.html)).toEqual(['<h3>Titolo principale</h3><p>Testo del paragrafo.</p>']);
  });

  it('preserves the source key when an intermediate body section is empty, so heading pairing never shifts (#3205)', () => {
    const sections = cleanupArticleBodySections(keyed([
      'Testo del primo blocco.',
      undefined, // body2 empty/dropped — must not shift body3's html onto body2's slot
      'Testo del terzo blocco.',
    ]));

    expect(sections).toHaveLength(2);
    expect(sections[0].key).toBe('body1');
    expect(sections[0].html).toContain('primo blocco');
    expect(sections[1].key).toBe('body3');
    expect(sections[1].html).toContain('terzo blocco');

    // Mirrors the caller-side pairing in staticPagesPlugin.ts / ogPagesPlugin.ts:
    // heading must be looked up by stable key, not by the post-filter array index
    // (which would wrongly pair body3's html with body2's heading).
    const headingByKey: Record<string, string> = {
      body1: 'Contesto',
      body2: 'Dettagli operativi',
      body3: 'Punti chiave',
    };
    const paired = sections.map((s) => ({ heading: headingByKey[s.key], html: s.html }));

    expect(paired[0].heading).toBe('Contesto');
    expect(paired[1].heading).toBe('Punti chiave');
  });
});
