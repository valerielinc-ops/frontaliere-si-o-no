/**
 * Tests for registryPinnedLocaleSlug — the shared "registry beats re-translated
 * title" decision used by both slug-derivation paths (hardenJobLocaleFields and
 * regenerate-slugs-by-locale.mjs).
 *
 * Root cause it guards: job slugs are derived from AI-translated titles, and AI
 * translation is non-deterministic, so a re-crawl can mint a different slug for
 * the same posting and strand the old URL. The immutable slug-registry is the
 * source of truth; this helper decides when its locked slug must win.
 *
 * Real-world case (UPD Bern, umantis 3164): a re-translated EN title produced
 * `psychology-assistant-specialized-...` while the registry holds
 * `assistant-psychologist-or-specialist-...` (the deployed, indexed URL).
 */
import { describe, expect, it } from 'vitest';
import { registryPinnedLocaleSlug } from '../scripts/lib/dedicated-crawler-common.mjs';

const REGISTERED = {
  canonicalSlug: 'psicologo-a-assistente-o-a-psicologo-a-specializzato-a-upd-bern',
  slugByLocale: {
    it: 'psicologo-a-assistente-o-a-psicologo-a-specializzato-a-upd-bern',
    en: 'assistant-psychologist-or-specialist-psychologist-upd-bern',
    de: 'assistenzpsychologin-assistenzpsychologe-oder-fachpsychologin-fachpsychologe-upd-bern',
    fr: 'psychologue-assistant-e-ou-psychologue-specialise-e-upd-bern',
  },
};

describe('registryPinnedLocaleSlug', () => {
  it('returns null when the job is not registered', () => {
    expect(registryPinnedLocaleSlug(null, 'en', 'de')).toBeNull();
    expect(registryPinnedLocaleSlug(undefined, 'en', 'de')).toBeNull();
  });

  it('returns null when the registry entry has no slugByLocale', () => {
    expect(registryPinnedLocaleSlug({ canonicalSlug: 'x' }, 'en', 'de')).toBeNull();
    expect(registryPinnedLocaleSlug({ slugByLocale: null }, 'en', 'de')).toBeNull();
  });

  it('returns null when the locale has no registered slug', () => {
    expect(registryPinnedLocaleSlug({ slugByLocale: { it: 'x' } }, 'en', 'de')).toBeNull();
    expect(registryPinnedLocaleSlug({ slugByLocale: { en: '' } }, 'en', 'de')).toBeNull();
  });

  it('returns the locked slug for a real non-source translation (the drift fix)', () => {
    // EN re-translation drift must lose to the registry-pinned EN slug.
    expect(registryPinnedLocaleSlug(REGISTERED, 'en', 'de')).toBe(
      'assistant-psychologist-or-specialist-psychologist-upd-bern',
    );
    expect(registryPinnedLocaleSlug(REGISTERED, 'it', 'de')).toBe(
      'psicologo-a-assistente-o-a-psicologo-a-specializzato-a-upd-bern',
    );
  });

  it('pins the source locale slug too (no source-copy guard applies to it)', () => {
    expect(registryPinnedLocaleSlug(REGISTERED, 'de', 'de')).toBe(
      'assistenzpsychologin-assistenzpsychologe-oder-fachpsychologin-fachpsychologe-upd-bern',
    );
  });

  it('returns null for a per-locale entry that just copies the source slug', () => {
    // Early entries registered before AI localization finished: every locale
    // slot is a byte copy of the source slug. Pinning those would revert a real
    // translation back to the source — worse than the drift we are fixing.
    const sourceCopy = {
      slugByLocale: {
        de: 'pflegefachperson-spital-bern',
        en: 'pflegefachperson-spital-bern',
        it: 'pflegefachperson-spital-bern',
      },
    };
    expect(registryPinnedLocaleSlug(sourceCopy, 'en', 'de')).toBeNull();
    expect(registryPinnedLocaleSlug(sourceCopy, 'it', 'de')).toBeNull();
    // The source locale itself is still pinned — it is not a "copy".
    expect(registryPinnedLocaleSlug(sourceCopy, 'de', 'de')).toBe('pflegefachperson-spital-bern');
  });

  it('pins a real translation even when no sourceLang is known', () => {
    // Without a source language we cannot detect source copies via the source
    // slot, but fully-translated entries have distinct per-locale slugs, so
    // the unknown-source duplicate rule never blocks them.
    expect(registryPinnedLocaleSlug(REGISTERED, 'en', null)).toBe(
      'assistant-psychologist-or-specialist-psychologist-upd-bern',
    );
  });

  it('refuses to pin from an all-copies entry when sourceLang is unknown (KSA full-wipe regression #3785/#3874)', () => {
    // Real poisoned entry shape: id|umantis.com|4698, registered 2026-07-09
    // with the raw DE slug frozen across every locale. With sourceLang missing
    // the old guard was disabled entirely, so every locale (and the master via
    // 'it') was re-pinned to the untranslated slug, wiping real translations
    // with no journal capture.
    const rawEverywhere = {
      canonicalSlug: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
      slugByLocale: {
        de: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        it: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        en: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        fr: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
      },
    };
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(registryPinnedLocaleSlug(rawEverywhere, locale, null)).toBeNull();
      expect(registryPinnedLocaleSlug(rawEverywhere, locale, undefined)).toBeNull();
      expect(registryPinnedLocaleSlug(rawEverywhere, locale, '')).toBeNull();
    }
  });

  it('with unknown sourceLang, pins only the locales whose registry value is unique (confederazione en/fr revert)', () => {
    // Real entry shape id|admin.ch|e1a55ed6…: it holds a real translation,
    // en/fr/de share the raw DE slug. Pinning en/fr from it reverted live
    // translations to the raw DE slug in prod (commit aea161ce08).
    const halfCopied = {
      canonicalSlug: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
      slugByLocale: {
        de: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
        it: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
        en: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
        fr: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
      },
    };
    expect(registryPinnedLocaleSlug(halfCopied, 'en', null)).toBeNull();
    expect(registryPinnedLocaleSlug(halfCopied, 'fr', null)).toBeNull();
    expect(registryPinnedLocaleSlug(halfCopied, 'de', null)).toBeNull();
    // The unique (really translated) locale still pins.
    expect(registryPinnedLocaleSlug(halfCopied, 'it', null)).toBe(
      'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
    );
    // With the source KNOWN the classic guard still governs (unchanged behavior).
    expect(registryPinnedLocaleSlug(halfCopied, 'en', 'de')).toBeNull();
    expect(registryPinnedLocaleSlug(halfCopied, 'it', 'de')).toBe(
      'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
    );
    expect(registryPinnedLocaleSlug(halfCopied, 'de', 'de')).toBe(
      'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
    );
  });
});
