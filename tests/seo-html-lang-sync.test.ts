/**
 * Phase 4B — `<html lang>` ↔ hreflang sync gate (Issue 204).
 *
 * SEMrush flagged 9 pages where the static `<html lang>` did not match
 * the locale of the runtime hreflang alternates after navigation. The
 * fix lives in `services/seoService.ts → updateSeoTags`: it now force-
 * syncs `document.documentElement.lang` against the URL-derived locale
 * even when `setLocale()` short-circuits because the in-memory locale
 * already matches.
 *
 * This test is structural: it grep-asserts that `seoService.ts` and
 * `i18n.ts` together implement the sync invariant, without booting the
 * full SEO pipeline (which depends on a heavy router/i18n graph).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SEO_SERVICE = readFileSync(
 resolve(__dirname, '..', 'services', 'seoService.ts'),
 'utf-8',
);
const I18N = readFileSync(resolve(__dirname, '..', 'services', 'i18n.ts'), 'utf-8');

describe('<html lang> ↔ hreflang sync invariants (Issue 204)', () => {
 it('setLocale() in i18n.ts sets document.documentElement.lang', () => {
  // Anchor: i18n.setLocale must update the html lang attribute so the
  // first navigation already syncs the document language.
  const setLocaleBody = I18N.match(/export function setLocale\([^)]*\): void \{([\s\S]*?)\n\}/);
  expect(setLocaleBody, 'setLocale function not found').toBeTruthy();
  expect(setLocaleBody![1]).toMatch(/document\.documentElement\.lang\s*=\s*locale/);
 });

 it('updateSeoTags() force-syncs document.documentElement.lang against the URL locale', () => {
  // Even when getLocale() === pathLocale (so setLocale short-circuits),
  // updateSeoTags must still align <html lang> with the URL-derived
  // locale to keep hreflang alternates and og:locale consistent.
  expect(SEO_SERVICE).toMatch(
   /document\.documentElement\.lang\s*!==\s*locale[\s\S]{0,200}document\.documentElement\.lang\s*=\s*locale/,
  );
 });

 it('updateDocumentLanguage() helper still updates html lang + og:locale', () => {
  // Public helper kept for non-route code paths (e.g. analytics) that
  // need to sync the language attribute outside updateSeoTags.
  const helperBody = SEO_SERVICE.match(
   /export function updateDocumentLanguage\([^)]*\): void \{([\s\S]*?)\n\}/,
  );
  expect(helperBody, 'updateDocumentLanguage helper not found').toBeTruthy();
  expect(helperBody![1]).toMatch(/document\.documentElement\.lang\s*=\s*locale/);
 });

 it('hreflang tag emission iterates the same locales the lang attribute can take', () => {
  // Sanity: the hreflang updater must emit one alternate per supported
  // locale; the lang attribute can only be set to one of these values.
  expect(SEO_SERVICE).toMatch(/'it',\s*'en',\s*'de',\s*'fr'/);
  expect(SEO_SERVICE).toMatch(/link\.hreflang\s*=\s*lang/);
 });
});
