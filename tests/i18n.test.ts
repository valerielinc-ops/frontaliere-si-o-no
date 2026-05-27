import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { getLocale, setLocale, t, ensureLocaleLoaded, itReady, loadTabTranslations, loadAllLocaleChunks, initLocale } from '@/services/i18n';

describe('i18n Service', () => {
  // Pre-load all locale data so t() works synchronously in tests
  beforeAll(async () => {
    await itReady;
    // Load all per-page IT chunks (itReady only loads core + calculator)
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
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    setLocale('it');
  });

  it('defaults to Italian locale', () => {
    expect(getLocale()).toBe('it');
  });

  it('translates known keys in Italian', () => {
    setLocale('it');
    expect(t('nav.simulator')).toBe('Calcolatore');
    expect(t('nav.pension')).toBe('Pensione');
  });

  it('switches to English locale', () => {
    setLocale('en');
    expect(t('nav.simulator')).toBe('Calculator');
    expect(t('nav.pension')).toBe('Pension');
  });

  it('switches to German locale', () => {
    setLocale('de');
    expect(t('nav.simulator')).toBe('Rechner');
  });

  it('switches to French locale', () => {
    setLocale('fr');
    expect(t('nav.simulator')).toBe('Calculateur');
  });

  it('returns the key when translation not found', () => {
    setLocale('it');
    expect(t('nonexistent.key.test')).toBe('nonexistent.key.test');
  });

  it('has companies translations in all locales', () => {
    setLocale('it');
    expect(t('companies.title', { canton: 'Ticino' })).toBe('Aziende in Ticino');
    setLocale('en');
    expect(t('companies.title', { canton: 'Ticino' })).toBe('Companies in Ticino');
    setLocale('de');
    expect(t('companies.title', { cantonPrep: 'im Tessin' })).toBe('Unternehmen im Tessin');
    setLocale('fr');
    expect(t('companies.title', { cantonPrep: 'au Tessin' })).toBe('Entreprises au Tessin');
  });

  it('has comparator sub-tab translations', () => {
    setLocale('en');
    expect(t('comparators.exchange')).toBe('Currency Exchange');
    expect(t('comparators.jobs')).toBe('Job Offers');
    expect(t('comparators.companies', { canton: 'Ticino' })).toBe('Ticino Companies');
  });

  it('keeps canonical Italian locale on non-prefixed deep links even if another locale is stored', () => {
    localStorage.setItem('frontaliere_locale', 'en');
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/manifestazione-di-interesse-international-school-of-ticino-international-school-of-ticino-lugano/');

    initLocale();

    expect(getLocale()).toBe('it');
  });

  it('uses the stored locale on the locale root', () => {
    localStorage.setItem('frontaliere_locale', 'en');
    window.history.replaceState({}, '', '/');

    initLocale();

    expect(getLocale()).toBe('en');
  });

  afterAll(() => setLocale('it'));
});
