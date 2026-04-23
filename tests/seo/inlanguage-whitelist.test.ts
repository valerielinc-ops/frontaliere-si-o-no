/**
 * Verifies that `inLanguage` is only assigned to schema types that officially
 * support it (CreativeWork + subclasses), and never to BreadcrumbList,
 * ItemList, SoftwareApplication, WebApplication, Organization, or Place.
 *
 * Also verifies that no hreflang <link> is emitted with an empty `hreflang`
 * or empty `href` attribute — Semrush flags empty hreflang codes as conflicts.
 *
 * Root cause: services/seoService.ts used to unconditionally assign
 *   clone.inLanguage = locale
 * on every cloned structured-data item. This produced ~6.4k Semrush errors
 * because BreadcrumbList / ItemList / SoftwareApplication do not accept the
 * inLanguage property per schema.org.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPath, getSeoSection, type AppRoute } from '@/services/router';
import { loadAllLocaleChunks, setLocale } from '@/services/i18n';

const { updateMetaTags } = await vi.importActual<typeof import('@/services/seoService')>(
 '@/services/seoService',
);

type AnySchema = Record<string, unknown> & { '@type'?: string | string[] };

function readEmittedSchemas(): AnySchema[] {
 const el = document.querySelector('#dynamic-structured-data');
 if (!el || !el.textContent) return [];
 const parsed = JSON.parse(el.textContent);
 const arr = Array.isArray(parsed) ? parsed : [parsed];
 return arr as AnySchema[];
}

function flatten(schemas: AnySchema[]): AnySchema[] {
 // Schemas can contain nested @graph arrays; flatten them for type checks.
 const out: AnySchema[] = [];
 for (const s of schemas) {
  if (!s || typeof s !== 'object') continue;
  out.push(s);
  const graph = (s as { '@graph'?: unknown })['@graph'];
  if (Array.isArray(graph)) out.push(...(graph as AnySchema[]));
 }
 return out;
}

function typeOf(schema: AnySchema): string {
 const t = schema['@type'];
 if (Array.isArray(t)) return String(t[0] ?? '');
 return String(t ?? '');
}

describe('seoService — inLanguage whitelist', () => {
 beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Clear any pre-existing structured data from the DOM
  document.querySelectorAll('#dynamic-structured-data').forEach((el) => el.remove());
 });

 it('does NOT emit inLanguage on BreadcrumbList or ItemList or SoftwareApplication/WebApplication', async () => {
  const route: AppRoute = { activeTab: 'calculator' };
  const section = getSeoSection(route);
  const path = buildPath(route, 'it');

  await loadAllLocaleChunks('it');
  setLocale('it');
  window.history.replaceState({}, '', path);
  await updateMetaTags(section);

  const schemas = flatten(readEmittedSchemas());
  expect(schemas.length).toBeGreaterThan(0);

  const forbidden = new Set([
   'BreadcrumbList',
   'ItemList',
   'SoftwareApplication',
   'WebApplication',
   'Organization',
   'Place',
  ]);

  const offenders = schemas
   .filter((s) => forbidden.has(typeOf(s)))
   .filter((s) => Object.prototype.hasOwnProperty.call(s, 'inLanguage'));

  expect(offenders.map((s) => ({ type: typeOf(s), inLanguage: s.inLanguage }))).toEqual([]);
 });

 it('DOES emit inLanguage on Article / BlogPosting when present', async () => {
  // Pick a blog section that is guaranteed to emit an Article-family schema.
  // Any non-blog page should still at least emit a BreadcrumbList WITHOUT inLanguage.
  const route: AppRoute = { activeTab: 'calculator' };
  const section = getSeoSection(route);
  const path = buildPath(route, 'en');

  await loadAllLocaleChunks('en');
  setLocale('en');
  window.history.replaceState({}, '', path);
  await updateMetaTags(section);

  const schemas = flatten(readEmittedSchemas());
  const supported = new Set([
   'Article',
   'NewsArticle',
   'BlogPosting',
   'WebPage',
   'CollectionPage',
   'FAQPage',
   'JobPosting',
   'HowTo',
   'Product',
   'CreativeWork',
   'Dataset',
  ]);
  const allowed = schemas.filter((s) => supported.has(typeOf(s)));
  // At least one supported schema (e.g. FAQPage or HowTo on the home page)
  // must carry inLanguage === 'en'.
  if (allowed.length > 0) {
   const withLang = allowed.filter((s) => (s as { inLanguage?: unknown }).inLanguage === 'en');
   expect(withLang.length).toBeGreaterThan(0);
  }
 });

 it('emits no hreflang link with empty lang or empty href', async () => {
  const route: AppRoute = { activeTab: 'calculator' };
  const section = getSeoSection(route);
  const path = buildPath(route, 'it');

  await loadAllLocaleChunks('it');
  setLocale('it');
  window.history.replaceState({}, '', path);
  await updateMetaTags(section);

  const links = Array.from(document.querySelectorAll('link[hreflang]')) as HTMLLinkElement[];
  expect(links.length).toBeGreaterThan(0);

  const empty = links.filter((l) => {
   const lang = l.getAttribute('hreflang') || '';
   const href = l.getAttribute('href') || '';
   return lang.trim() === '' || href.trim() === '';
  });

  expect(empty.map((l) => ({ lang: l.getAttribute('hreflang'), href: l.getAttribute('href') }))).toEqual([]);
 });
});
