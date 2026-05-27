/**
 * Runtime guard for t(): if a malformed locale chunk ships an object value
 * under any key, t() must NOT return the object (which would crash React
 * with error #31 — "Objects are not valid as a React child"). Instead, it
 * must fall back to the fallback string or the key itself.
 *
 * GA4 telemetry from May 2026 surfaced 25 such errors on the homepage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('i18n t() guard against object-valued translations', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/services/locales/it-critical');
    vi.resetModules();
  });

  it('returns the fallback string when the cache contains an object under that key', async () => {
    vi.doMock('@/services/locales/it-critical', () => ({
      default: {
        // Deliberately malformed: object instead of string.
        'broken-key': { value: 'oops' } as unknown as string,
        // A legitimate key alongside, to make sure normal lookups still work.
        'app.title': 'Frontaliere Ticino',
      },
    }));

    const { t, setLocale, itReady } = await import('@/services/i18n');
    await itReady;
    setLocale('it');

    // Sanity: legitimate string key still works.
    expect(t('app.title')).toBe('Frontaliere Ticino');

    // Malformed object value must be replaced by the fallback.
    expect(t('broken-key', 'fallback')).toBe('fallback');
  });

  it('returns the key itself when the cache contains an object and no fallback is given', async () => {
    vi.doMock('@/services/locales/it-critical', () => ({
      default: {
        'broken-key': { value: 'oops' } as unknown as string,
      },
    }));

    const { t, setLocale, itReady } = await import('@/services/i18n');
    await itReady;
    setLocale('it');

    // No fallback provided — t() must return the key as last resort,
    // never an object that React would refuse to render.
    const result = t('broken-key');
    expect(typeof result).toBe('string');
    expect(result).toBe('broken-key');
  });
});
