import { describe, it, expect, vi } from 'vitest';
import {
  fetchWordpressSearchHeadlines,
  WP_SOURCES,
  SEARCH_TERM,
  stripHtml,
} from '../../../../scripts/lib/topic-sources/wordpressSearch.mjs';

describe('wordpressSearch.stripHtml', () => {
  it('strips tags and decodes common entities', () => {
    expect(stripHtml('<p>Hello &amp; goodbye</p>')).toBe('Hello & goodbye');
    expect(stripHtml('Tom&#8217;s &quot;quote&quot;')).toBe(`Tom's "quote"`);
    expect(stripHtml('  multi  \n  space  ')).toBe('multi space');
  });

  it('handles undefined / null', () => {
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(42)).toBe('42');
  });
});

describe('wordpressSearch.WP_SOURCES', () => {
  it('lists configured sources with required fields', () => {
    expect(WP_SOURCES.length).toBeGreaterThan(0);
    for (const s of WP_SOURCES) {
      expect(typeof s.domain).toBe('string');
      expect(typeof s.host).toBe('string');
      expect(s.domain.length).toBeGreaterThan(3);
    }
  });

  it('uses "frontalier" as the search stem (matches frontaliere/frontalieri/frontaliera)', () => {
    expect(SEARCH_TERM).toBe('frontalier');
  });
});

describe('wordpressSearch.fetchWordpressSearchHeadlines', () => {
  it('returns headlines from a mocked WP REST response with valid shape', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      expect(url).toContain('/wp-json/wp/v2/posts');
      expect(url).toContain('search=frontalier');
      const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      return {
        ok: true,
        async json() {
          return [
            {
              id: 1,
              link: 'https://example.com/post-1/',
              date: recent,
              title: { rendered: 'Frontalieri in Ticino: <em>nuove</em> regole 2026' },
            },
            {
              id: 2,
              link: 'https://example.com/post-2/',
              date: recent,
              title: { rendered: 'Permesso G &#8211; chiarimenti' },
            },
          ];
        },
      } as any;
    });

    const result = await fetchWordpressSearchHeadlines({ fetchImpl: fetchImpl as any });
    expect(result.length).toBeGreaterThan(0);
    for (const h of result) {
      expect(h).toMatchObject({
        url: expect.any(String),
        headline: expect.any(String),
        source: expect.stringMatching(/^wp-search:/),
      });
      expect(h.date).toBeInstanceOf(Date);
      expect(h.headline).not.toContain('<');
    }
  });

  it('drops articles older than maxAgeDays', async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      async json() {
        return [{ id: 1, link: 'https://example.com/old/', date: old, title: { rendered: 'Frontalieri 2025' } }];
      },
    } as any);

    const result = await fetchWordpressSearchHeadlines({ fetchImpl: fetchImpl as any, maxAgeDays: 7 });
    expect(result).toEqual([]);
  });

  it('returns empty array when API responds with non-200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as any);
    const result = await fetchWordpressSearchHeadlines({ fetchImpl: fetchImpl as any });
    expect(result).toEqual([]);
  });

  it('returns empty array when API throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await fetchWordpressSearchHeadlines({ fetchImpl: fetchImpl as any });
    expect(result).toEqual([]);
  });

  it('skips entries with missing url or short headline', async () => {
    const recent = new Date().toISOString();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      async json() {
        return [
          { id: 1, link: '', date: recent, title: { rendered: 'Frontalieri Ticino calo' } },
          { id: 2, link: 'https://example.com/x/', date: recent, title: { rendered: 'short' } },
          { id: 3, link: 'https://example.com/ok/', date: recent, title: { rendered: 'Frontalieri valid headline' } },
        ];
      },
    } as any);

    const result = await fetchWordpressSearchHeadlines({ fetchImpl: fetchImpl as any });
    expect(result.length).toBe(WP_SOURCES.length); // 1 valid per site
    for (const h of result) {
      expect(h.headline).toBe('Frontalieri valid headline');
    }
  });
});
