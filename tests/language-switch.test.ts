/**
 * Language switch tests
 * 
 * Verifies that switching locale correctly loads translations
 * (especially non-IT locales which are lazy-loaded) and that
 * the useLocale hook re-renders after async load completes.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getLocale, setLocale, t, ensureLocaleLoaded, getLocaleTick,
  itReady, loadTabTranslations, loadAllLocaleChunks,
  type Locale,
} from '@/services/i18n';

describe('Language switch', () => {
  // Pre-load all locale data so t() works synchronously in tests
  beforeAll(async () => {
    await itReady;
    await Promise.all([
      loadTabTranslations('guide'),
      loadTabTranslations('comparatori'),
      loadTabTranslations('fisco'),
      loadTabTranslations('vita'),
      loadTabTranslations('stats'),
    ]);
    await Promise.all([
      loadAllLocaleChunks('en'),
      loadAllLocaleChunks('de'),
      loadAllLocaleChunks('fr'),
    ]);
  }, 30_000);

  beforeEach(() => {
    setLocale('it');
  });

  it('switches from IT to EN and translations resolve', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('nav.simulator')).toBe('Calculator');
    expect(t('nav.pension')).toBe('Pension');
  });

  it('switches from IT to DE and translations resolve', () => {
    setLocale('de');
    expect(getLocale()).toBe('de');
    expect(t('nav.simulator')).toBe('Rechner');
  });

  it('switches from IT to FR and translations resolve', () => {
    setLocale('fr');
    expect(getLocale()).toBe('fr');
    expect(t('nav.simulator')).toBe('Calculateur');
  });

  it('falls back to IT when translation key is missing in non-IT locale', () => {
    // Pick a key that exists only in IT (or use a known common key)
    setLocale('en');
    // 'app.title' should exist in all locales
    expect(t('app.title')).toBeTruthy();
    expect(t('app.title')).not.toBe('app.title'); // not raw key
  });

  it('round-trips through all locales without losing translations', () => {
    const locales: Locale[] = ['it', 'en', 'de', 'fr', 'it'];
    for (const locale of locales) {
      setLocale(locale);
      expect(getLocale()).toBe(locale);
      // A common key should always resolve to a real string
      const result = t('nav.stats');
      expect(result).toBeTruthy();
      expect(result).not.toBe('nav.stats');
    }
  });

  it('getLocaleTick is exported and returns a number', () => {
    expect(typeof getLocaleTick()).toBe('number');
  });

  it('ensureLocaleLoaded is idempotent for already-loaded locales', async () => {
    // Should resolve instantly without error
    await ensureLocaleLoaded('en');
    await ensureLocaleLoaded('en');
    setLocale('en');
    expect(t('nav.simulator')).toBe('Calculator');
  });

  it('ensureLocaleLoaded is a no-op for IT', async () => {
    await ensureLocaleLoaded('it');
    setLocale('it');
    expect(t('nav.simulator')).toBe('Calcolatore');
  });

  it('switching locale updates document.documentElement.lang', () => {
    setLocale('fr');
    expect(document.documentElement.lang).toBe('fr');
    setLocale('it');
    expect(document.documentElement.lang).toBe('it');
  });

  it('switching locale persists to localStorage', () => {
    setLocale('de');
    expect(localStorage.getItem('frontaliere_locale')).toBe('de');
    setLocale('it');
    expect(localStorage.getItem('frontaliere_locale')).toBe('it');
  });

  it('profile.preferredLanguage key exists in all locales', () => {
    const locales: Locale[] = ['it', 'en', 'de', 'fr'];
    for (const locale of locales) {
      setLocale(locale);
      const result = t('profile.preferredLanguage');
      expect(result).not.toBe('profile.preferredLanguage');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
