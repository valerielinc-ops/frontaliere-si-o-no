import { describe, it, expect } from 'vitest';
import { estimateReadingMinutes, ARTICLES } from '@/components/community/BlogArticles';

// ── Mock translation function ───────────────────────────────
/** Returns a string with the given word count for body1; empty for body2/body3 */
function mockT(wordsInBody1: number) {
  const words = Array.from({ length: wordsInBody1 }, (_, i) => `parola${i}`).join(' ');
  return (key: string) => {
    if (key.endsWith('.body1')) return words;
    if (key.endsWith('.body2')) return '';
    if (key.endsWith('.body3')) return '';
    return key; // fallback
  };
}

describe('estimateReadingMinutes', () => {
  it('returns 2 min minimum for very short articles', () => {
    // 50 words at 230 wpm → 0.2 → rounds to 0, clamped to 2
    expect(estimateReadingMinutes('test', mockT(50))).toBe(2);
  });

  it('returns correct estimate for medium articles', () => {
    // 1150 words at 230 wpm → exactly 5 min
    expect(estimateReadingMinutes('test', mockT(1150))).toBe(5);
  });

  it('returns 30 min maximum for very long articles', () => {
    // 10000 words at 230 wpm → 43.5 → clamped to 30
    expect(estimateReadingMinutes('test', mockT(10000))).toBe(30);
  });

  it('strips HTML tags from content', () => {
    const t = (key: string) => {
      if (key.endsWith('.body1')) return '<p>word1 <strong>word2</strong> word3</p>'.repeat(77); // 3 words × 77 = 231 words
      return '';
    };
    expect(estimateReadingMinutes('test', t)).toBe(2); // 231/230 ≈ 1 → clamped to 2
  });

  it('handles 690 words (3 min)', () => {
    expect(estimateReadingMinutes('test', mockT(690))).toBe(3);
  });

  it('handles 2300 words (10 min)', () => {
    expect(estimateReadingMinutes('test', mockT(2300))).toBe(10);
  });
});

describe('ARTICLES integrity', () => {
  it('no article has a readingMinutes property', () => {
    for (const article of ARTICLES) {
      expect(article).not.toHaveProperty('readingMinutes');
    }
  });

  it('every article has required fields', () => {
    for (const article of ARTICLES) {
      expect(article.id).toBeTruthy();
      expect(article.category).toBeTruthy();
      expect(article.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(article.image).toBeTruthy();
      expect(typeof article.hasCalculator).toBe('boolean');
    }
  });
});
