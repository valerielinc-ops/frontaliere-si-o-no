// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// Site search calls loadAllTranslations() with `void`. A failed locale chunk
// fetch must not escape as an unhandled rejection: the page keeps Italian labels
// for that chunk and the next call retries it.
const chunk = vi.hoisted(() => ({ fail: true }));

vi.mock('@/services/locales/en-stats', async (importOriginal) => {
  if (chunk.fail) {
    throw new TypeError('error loading dynamically imported module: https://cdn.example/assets/en-stats.js');
  }
  return importOriginal();
});

import { loadAllTranslations, setLocale, t } from '@/services/i18n';

describe('loadAllTranslations with a failed locale chunk', () => {
  it('resolves, falls back to Italian for the failed chunk, and retries it on the next call', async () => {
    setLocale('en');

    await expect(loadAllTranslations()).resolves.toBeUndefined();
    expect(t('permits.title')).toBe('Swiss Work Permit Guide');
    expect(t('salary.title')).toBe('Quanto guadagnano i frontalieri?');

    chunk.fail = false;
    await loadAllTranslations();
    expect(t('salary.title')).toBe('How much do cross-border workers earn?');
  }, 30_000);
});
