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

  it('deduplicates when a keyword and its expansion overlap', () => {
    const expanded = expandKeywordsWithSynonyms(['infermiere']);
    const count = expanded.filter((k) => k === 'infermiere').length;
    expect(count).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(expandKeywordsWithSynonyms([])).toEqual([]);
  });
});
