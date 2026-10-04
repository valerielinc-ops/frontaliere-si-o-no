// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORS } from '../data/authors';
import { localizeAuthor } from '../data/authorLocales';
import { buildAuthorSeo } from '../services/seo/seo-authors';
import { setLocale } from '../services/i18n';
vi.unmock('@/services/seoService');
vi.unmock('../services/seoService');

afterEach(() => { window.history.replaceState({}, '', '/'); document.head.innerHTML = ''; document.body.innerHTML = ''; });

describe('author metadata emitted by updateMetaTags', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('preserves Person identity and full localized biography in %s', async locale => {
    const author = AUTHORS[0];
    const expected = localizeAuthor(author, locale);
    const seo = buildAuthorSeo(author, locale);
    // Exercise route-based locale detection without depending on a downloaded translation chunk.
    setLocale('it');
    window.history.replaceState({}, '', new URL(seo.canonical).pathname);
    document.head.innerHTML = '<title>Previous route</title>';
    const { updateMetaTags } = await import('../services/seoService');
    await updateMetaTags(`autore-${author.slug}`);
    const schemas = Array.from(document.head.querySelectorAll('script[type="application/ld+json"]'), script => JSON.parse(script.textContent!));
    const person = schemas.find(schema => schema['@type'] === 'Person');
    expect(person).toBeDefined();
    expect(person.name).toBe(author.name);
    expect(person.description).toBe(expected.bio);
    expect(person.jobTitle).toBe(expected.role);
    expect(person.knowsAbout).toEqual(expected.expertise);
    expect(person.url).toBe(seo.canonical);
    expect(document.title).toBe(seo.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(seo.description);
  });
});
