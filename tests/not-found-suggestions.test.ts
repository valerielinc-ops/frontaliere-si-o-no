import { describe, it, expect } from 'vitest';
import { parsePath } from '@/services/router';
import { extractKeywords, detectContentType } from '@/components/shared/NotFoundSuggestions';

describe('NotFoundSuggestions — parsePath notFoundPath', () => {
  it('does NOT set notFoundPath for root URL', () => {
    const result = parsePath('/');
    expect(result.notFoundPath).toBeUndefined();
    expect(result.route.activeTab).toBe('calculator');
  });

  it('does NOT set notFoundPath for known Italian routes', () => {
    const routes = [
      '/calcola-stipendio',
      '/compara-servizi',
      '/articoli-frontaliere',
      '/cerca-lavoro-ticino',
    ];
    for (const path of routes) {
      const result = parsePath(path);
      expect(result.notFoundPath, `Expected no notFoundPath for ${path}`).toBeUndefined();
    }
  });

  it('does NOT set notFoundPath for known English routes', () => {
    const result = parsePath('/en/calculate-salary');
    expect(result.notFoundPath).toBeUndefined();
  });

  it('sets notFoundPath for completely unknown URLs', () => {
    const result = parsePath('/this-page-does-not-exist-xyz');
    expect(result.notFoundPath).toBe('/this-page-does-not-exist-xyz');
    expect(result.route.activeTab).toBe('calculator');
  });

  it('sets notFoundPath for unknown deep paths', () => {
    const result = parsePath('/foo/bar/baz');
    expect(result.notFoundPath).toBe('/foo/bar/baz');
  });
});

describe('NotFoundSuggestions — extractKeywords', () => {
  it('extracts meaningful words from article slugs', () => {
    const kws = extractKeywords('/articoli-frontaliere/universita-ticino-frontalieri');
    expect(kws).toContain('universita');
    expect(kws).toContain('ticino');
    expect(kws).toContain('frontalieri');
    expect(kws).toContain('articoli');
  });

  it('filters out stop words and short words', () => {
    const kws = extractKeywords('/il-la-di-da-ab');
    // 'il', 'la', 'di', 'da' are stop words; 'ab' is too short
    expect(kws).toHaveLength(0);
  });

  it('handles job slugs with long compound names', () => {
    const kws = extractKeywords('/cerca-lavoro-ticino/distributore-rifornimenti-programma-tirocinio');
    expect(kws).toContain('cerca');
    expect(kws).toContain('lavoro');
    expect(kws).toContain('distributore');
    expect(kws).toContain('rifornimenti');
    expect(kws).toContain('programma');
    expect(kws).toContain('tirocinio');
  });

  it('returns empty array for root path', () => {
    const kws = extractKeywords('/');
    expect(kws).toHaveLength(0);
  });
});

describe('NotFoundSuggestions — detectContentType', () => {
  it('detects article URLs', () => {
    expect(detectContentType('/articoli-frontaliere/some-article')).toBe('article');
    expect(detectContentType('/blog/post')).toBe('article');
  });

  it('detects job URLs', () => {
    expect(detectContentType('/cerca-lavoro-ticino/some-job')).toBe('job');
    expect(detectContentType('/job-board/position')).toBe('job');
  });

  it('detects guide URLs', () => {
    expect(detectContentType('/guida-frontaliere/something')).toBe('guide');
  });

  it('detects section URLs', () => {
    expect(detectContentType('/calcolatore/something')).toBe('section');
    expect(detectContentType('/confronti/something')).toBe('section');
    expect(detectContentType('/fisco/something')).toBe('section');
  });

  it('returns unknown for unrecognizable URLs', () => {
    expect(detectContentType('/random-path')).toBe('unknown');
  });
});
