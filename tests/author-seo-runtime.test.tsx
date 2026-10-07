// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORS, isEditorialProfile, isRealAuthor } from '../data/authors';
import { EDITORIAL_PROFILE_DISCLOSURE, localizeAuthor } from '../data/authorLocales';
import { buildAuthorSeo } from '../services/seo/seo-authors';
import { setLocale } from '../services/i18n';
vi.unmock('@/services/seoService');
vi.unmock('../services/seoService');

afterEach(() => { window.history.replaceState({}, '', '/'); document.head.innerHTML = ''; document.body.innerHTML = ''; });

describe('author metadata emitted by updateMetaTags', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('preserves editorial Organization identity and localized description in %s', async locale => {
    const author = AUTHORS.find(isEditorialProfile)!;
    const expected = localizeAuthor(author, locale);
    const seo = buildAuthorSeo(author, locale);
    // Exercise route-based locale detection without depending on a downloaded translation chunk.
    setLocale('it');
    window.history.replaceState({}, '', new URL(seo.canonical).pathname);
    document.head.innerHTML = '<title>Previous route</title>';
    const { updateMetaTags } = await import('../services/seoService');
    await updateMetaTags(`autore-${author.slug}`);
    const schemas = Array.from(document.head.querySelectorAll('script[type="application/ld+json"]'), script => JSON.parse(script.textContent!));
    const profile = schemas.find(schema => schema['@type'] === 'Organization' && schema['@id']?.endsWith('#profile'));
    expect(profile).toBeDefined();
    expect(profile.name).toBe(author.name);
    expect(profile.description).toBe(expected.bio);
    expect(profile.disambiguatingDescription).toBe(EDITORIAL_PROFILE_DISCLOSURE[locale]);
    expect(profile.knowsAbout).toEqual(expected.expertise);
    expect(profile.url).toBe(seo.canonical);
    expect(profile.jobTitle).toBeUndefined();
    expect(profile.sameAs).toBeUndefined();
    expect(document.title).toBe(seo.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(seo.description);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('emits the real guest author as Person with sameAs in %s', async locale => {
    const author = AUTHORS.find((candidate) => candidate.slug === 'samuele-valente');
    expect(author && isRealAuthor(author)).toBe(true);
    if (!author || !isRealAuthor(author)) return;
    const expected = localizeAuthor(author, locale);
    const seo = buildAuthorSeo(author, locale);
    setLocale('it');
    window.history.replaceState({}, '', new URL(seo.canonical).pathname);
    document.head.innerHTML = '<title>Previous route</title>';
    const { updateMetaTags } = await import('../services/seoService');
    await updateMetaTags(`autore-${author.slug}`);
    const schemas = Array.from(document.head.querySelectorAll('script[type="application/ld+json"]'), script => JSON.parse(script.textContent!));
    const person = schemas.find(schema => schema['@type'] === 'Person' && schema['@id']?.endsWith('#person'));
    expect(person).toBeDefined();
    expect(person.name).toBe(author.name);
    expect(person.description).toBe(expected.bio);
    expect(person.sameAs).toEqual([author.social.linkedin]);
    expect(person.disambiguatingDescription).toBeUndefined();
    expect(document.title).toBe(seo.title);
  });
});
