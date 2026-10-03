import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExchangeSitemapXml } from '../build-plugins/exchangeRatePagesPlugin';
import { renderSitemapLastmod } from '../build-plugins/shared/sitemapLastmod';

const current = Date.now();
const daysAgo = (days: number) => new Date(current - days * 86_400_000).toISOString().slice(0, 10);
afterEach(() => vi.useRealTimers());

describe('substantive sitemap dates', () => {
  it('keeps a real observation date stable across rebuilds and advances with new data', () => {
    const paths = ['/cambio-franco-euro/', '/cambio-franco-euro/4000-franchi-in-euro/'];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(current);
    const original = buildExchangeSitemapXml(paths, daysAgo(4));
    vi.setSystemTime(current + 2 * 86_400_000);
    expect(buildExchangeSitemapXml(paths, daysAgo(4))).toBe(original);
    expect(original).toContain(`<lastmod>${daysAgo(4)}</lastmod>`);
    const updated = buildExchangeSitemapXml(paths, daysAgo(1));
    expect(updated).toContain(`<lastmod>${daysAgo(1)}</lastmod>`);
    expect(updated.replaceAll(daysAgo(1), daysAgo(4))).toBe(original);
    expect(buildExchangeSitemapXml(paths, undefined)).not.toContain('<lastmod>');
  });

  it('does not manufacture a date for missing, impossible or future source timestamps', () => {
    for (const invalid of [undefined, null, '', 'invalid', '2025-02-30', daysAgo(-2)]) {
      expect(renderSitemapLastmod(invalid)).toBe('');
    }
    expect(renderSitemapLastmod(`${daysAgo(2)}T12:00:00.000Z`)).toBe(`<lastmod>${daysAgo(2)}</lastmod>`);
  });
});
