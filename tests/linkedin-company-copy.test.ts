import { describe, expect, it } from 'vitest';

import { buildLinkedInCompanyCommentary } from '../scripts/lib/linkedin-company-copy.mjs';

describe('LinkedIn Company Page commentary', () => {
  it('uses the generated CTA as the single action and attaches its tagged destination', () => {
    const taggedUrl = 'https://frontaliereticino.ch/articoli-frontaliere/example/?utm_source=linkedin';
    const text = buildLinkedInCompanyCommentary({
      emoji: '📰',
      title: 'Una guida pratica',
      description: 'Un riepilogo editoriale.',
      socialCopy: {
        copyMode: 'codex',
        hook: 'Un chiarimento utile per chi lavora oltre confine',
        cta: 'Leggi l’approfondimento completo',
      },
      url: taggedUrl,
      hashtags: '#frontalieri',
    });

    expect(text).toContain('Leggi l’approfondimento completo: ' + taggedUrl);
    expect(text.match(/👉/gu)).toHaveLength(1);
    expect(text).not.toContain("Leggi l'articolo completo");
  });

  it('keeps the deterministic single-CTA fallback when the pack is absent', () => {
    const text = buildLinkedInCompanyCommentary({
      title: 'Una guida pratica',
      url: 'https://example.test/article/',
      hashtags: '#frontalieri',
    });

    expect(text).toContain("👉 Leggi l'articolo completo: https://example.test/article/");
    expect(text.match(/👉/gu)).toHaveLength(1);
  });
});
