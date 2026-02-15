import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { getLocale, setLocale, t, ensureLocaleLoaded } from '@/services/i18n';

describe('i18n Service', () => {
  // Pre-load all locale data so t() works synchronously in tests
  beforeAll(async () => {
    await Promise.all([
      ensureLocaleLoaded('en'),
      ensureLocaleLoaded('de'),
      ensureLocaleLoaded('fr'),
    ]);
  });
  it('defaults to Italian locale', () => {
    expect(getLocale()).toBe('it');
  });

  it('translates known keys in Italian', () => {
    setLocale('it');
    expect(t('nav.simulator')).toBe('Simulatore');
    expect(t('nav.pension')).toBe('Pensione');
  });

  it('switches to English locale', () => {
    setLocale('en');
    expect(t('nav.simulator')).toBe('Simulator');
    expect(t('nav.pension')).toBe('Pension');
  });

  it('switches to German locale', () => {
    setLocale('de');
    expect(t('nav.simulator')).toBe('Simulator');
  });

  it('switches to French locale', () => {
    setLocale('fr');
    expect(t('nav.simulator')).toBe('Simulateur');
  });

  it('returns the key when translation not found', () => {
    setLocale('it');
    expect(t('nonexistent.key.test')).toBe('nonexistent.key.test');
  });

  it('has companies translations in all locales', () => {
    setLocale('it');
    expect(t('companies.title')).toBe('Aziende in Ticino');
    setLocale('en');
    expect(t('companies.title')).toBe('Companies in Ticino');
    setLocale('de');
    expect(t('companies.title')).toBe('Unternehmen im Tessin');
    setLocale('fr');
    expect(t('companies.title')).toBe('Entreprises au Tessin');
  });

  it('has comparator sub-tab translations', () => {
    setLocale('en');
    expect(t('comparators.exchange')).toBe('Currency Exchange');
    expect(t('comparators.jobs')).toBe('Job Offers');
    expect(t('comparators.companies')).toBe('Ticino Companies');
  });

  afterAll(() => setLocale('it'));
});
