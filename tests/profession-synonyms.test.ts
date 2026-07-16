/**
 * Tests for services/professionSynonyms — the query-time bridge between
 * scripts/lib/profession-taxonomy.mjs (SEO keyword data) and the interactive
 * search matchers (JobBoard, chatbotTools).
 */
import { describe, it, expect } from 'vitest';
import {
  professionSynonymText,
  expandKeywordsWithSynonyms,
} from '@/services/professionSynonyms';

describe('professionSynonymText', () => {
  it('returns cross-locale aliases for a recognised Italian job title', () => {
    const text = professionSynonymText('Infermiera SSR — Ospedale Regionale di Lugano');
    expect(text).toContain('nurse');
    expect(text).toContain('pflegefachfrau');
    expect(text).toContain('infirmier');
  });

  it('returns empty string for a title matching no known profession', () => {
    expect(professionSynonymText('Addetto imballaggio stagionale')).toBe('');
  });

  it('handles undefined/null/empty input without throwing', () => {
    expect(professionSynonymText(undefined)).toBe('');
    expect(professionSynonymText(null)).toBe('');
    expect(professionSynonymText('')).toBe('');
  });

  it('is memoized without leaking results across different titles (#4270)', () => {
    // Interleave repeat calls to two distinct titles — a cache keyed
    // incorrectly (e.g. shared/global instead of per-input) would return
    // the wrong title's result on the second call.
    const nurse = professionSynonymText('Infermiera SSR — Ospedale Regionale di Lugano');
    const cook = professionSynonymText('Cuoco di partita');
    expect(professionSynonymText('Infermiera SSR — Ospedale Regionale di Lugano')).toBe(nurse);
    expect(professionSynonymText('Cuoco di partita')).toBe(cook);
    expect(nurse).not.toBe(cook);
    expect(nurse).toContain('nurse');
    expect(cook).toContain('cook');
  });
});

describe('expandKeywordsWithSynonyms', () => {
  it('expands an English keyword to include the Italian job-title term', () => {
    const expanded = expandKeywordsWithSynonyms(['nurse']);
    expect(expanded).toContain('nurse');
    expect(expanded).toContain('infermiere');
    expect(expanded).toContain('infermiera');
  });

  it('expands a German keyword to include the French/Italian equivalents', () => {
    const expanded = expandKeywordsWithSynonyms(['physiotherapeut']);
    expect(expanded).toContain('fisioterapista');
    expect(expanded).toContain('physiotherapeute');
  });

  it('leaves non-profession keywords untouched (no expansion, no crash)', () => {
    const expanded = expandKeywordsWithSynonyms(['lugano', 'part-time']);
    expect(expanded).toEqual(expect.arrayContaining(['lugano', 'part-time']));
    expect(expanded.length).toBe(2);
  });

  it('never attempts a taxonomy lookup for locality/stopword/digit tokens (#4270 guard)', () => {
    // These are exactly the kind of non-profession tokens the LLM/heuristic
    // extractor's keyword list can contain (canton/city names, search
    // filler words, years). The guard in isPlausibleProfessionToken() must
    // reject them before matchProfession ever scans the taxonomy, so a
    // future alias addition can't turn one of them into a false-positive
    // profession match.
    const guardedTokens = ['ticino', 'berna', 'zurigo', 'cerco', 'lavoro', '2026'];
    for (const token of guardedTokens) {
      expect(expandKeywordsWithSynonyms([token])).toEqual([token]);
    }
  });

  it('only expands the profession-plausible token when mixed with locality/stopword noise', () => {
    const expanded = expandKeywordsWithSynonyms(['nurse', 'ticino', 'cerco']);
    expect(expanded).toEqual(expect.arrayContaining(['nurse', 'ticino', 'cerco', 'infermiere', 'infermiera']));
    expect(expanded).not.toContain('koch');
  });

  it('deduplicates when a keyword and its expansion overlap', () => {
    const expanded = expandKeywordsWithSynonyms(['infermiere']);
    const count = expanded.filter((k) => k === 'infermiere').length;
    expect(count).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(expandKeywordsWithSynonyms([])).toEqual([]);
  });
});
