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
import { registryPinnedLocaleSlug, sourceSlugPinContext } from '../scripts/lib/dedicated-crawler-common.mjs';

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

  describe('garbage-pin guard (#4071)', () => {
    // Real corruption shape (KSA, umantis 122706): the registry pins a garbage
    // DE slug for nursing vacancies whose title is unrelated to it, so every
    // re-crawl re-pinned "logi-hyardfachfrau-…" over the correct slug. Note the
    // guard is PER-LOCALE and driven by titleByLocale, because
    // hardenJobLocaleFields re-detects the KSA German title's source as `it`,
    // making the corrupt `de` slot a "non-source" locale from its view.
    const GARBLED = {
      canonicalSlug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
      slugByLocale: {
        it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-5',
        en: 'registered-nurse-nursing-professional-kantonsspital-aarau-ksa-aarau',
        fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
        de: 'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau-2767b3',
      },
    };
    // Per-locale titles (all German here — nursing title untranslated across it/de).
    const ctx = {
      titleByLocale: {
        it: 'Dipl. Pflegefachfrau / Pflegefachmann',
        de: 'Dipl. Pflegefachfrau / Pflegefachmann',
        en: 'Registered Nurse / Nursing Professional',
        fr: 'Infirmier Diplômé / Infirmière Diplômée',
      },
      company: 'Kantonsspital Aarau (KSA)',
      location: 'Aarau',
    };

    it('refuses a pin with zero title-token overlap with BOTH its locale title and canonicalSlug', () => {
      // KSA garbage `de`: "logi-hyardfachfrau-…" shares nothing with the DE title
      // nor the canonical ("dipl-pflegefachfrau-…-ksa-ch") after ksa/aarau noise.
      // Refused whether the DE slot is treated as source (de) or non-source (it).
      expect(registryPinnedLocaleSlug(GARBLED, 'de', 'de', ctx)).toBeNull();
      expect(registryPinnedLocaleSlug(GARBLED, 'de', 'it', ctx)).toBeNull();
    });

    it('KEEPS a valid-but-generic pin that still shares the canonical token (anti-churn, harden-registry-pin-quality-repair)', () => {
      // Real regression shape (EOC, umantis 2908): source-lang detection lands
      // on EN and overwrites the EN title to the German base ("Informatiker/in"),
      // so the pinned boilerplate slug no longer matches its (mutated) title —
      // but it still carries the job's canonical token "informatico", so it is a
      // valid indexed URL and MUST stay pinned, not churned.
      const boilerplate = 'permette-di-combinare-efficacemente-informatico-eoc-bellinzona';
      const registered = {
        canonicalSlug: 'informatico-a-eoc-bellinzona',
        slugByLocale: {
          it: 'informatico-a-eoc-bellinzona',
          en: boilerplate,
          de: 'informatiker-in-eoc-bellinzona',
          fr: 'informaticien-ne-eoc-bellinzona',
        },
      };
      const eocCtx = {
        titleByLocale: { it: 'Informatico/a', en: 'Informatiker/in', de: 'Informatiker/in', fr: 'Informaticien/ne' },
        company: 'EOC',
        location: 'Bellinzona',
      };
      expect(registryPinnedLocaleSlug(registered, 'en', 'en', eocCtx)).toBe(boilerplate);
    });

    it('KEEPS a real translation that shares tokens with its OWN locale title (never churned)', () => {
      // EN registry slug is a real English translation: it shares nurse/nursing
      // with the EN title, so it stays pinned even under the per-locale guard.
      expect(registryPinnedLocaleSlug(GARBLED, 'en', 'it', ctx)).toBe(
        'registered-nurse-nursing-professional-kantonsspital-aarau-ksa-aarau',
      );
    });

    it('does NOT refuse when the entry has no canonicalSlug (conservative — no second witness, no churn)', () => {
      const noCanonical = {
        slugByLocale: { de: 'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau' },
      };
      expect(registryPinnedLocaleSlug(noCanonical, 'de', 'de', ctx)).toBe(
        'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau',
      );
    });

    it('still pins a slug that DOES encode its locale title', () => {
      const healthy = {
        canonicalSlug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
        slugByLocale: { de: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch' },
      };
      expect(registryPinnedLocaleSlug(healthy, 'de', 'de', ctx)).toBe(
        'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
      );
    });

    it('is backward-compatible: without titleByLocale the pin is honored unconditionally', () => {
      expect(registryPinnedLocaleSlug(GARBLED, 'de', 'de')).toBe(
        'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau-2767b3',
      );
      expect(registryPinnedLocaleSlug(GARBLED, 'de', 'de', {})).toBe(
        'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau-2767b3',
      );
    });

    it('sourceSlugPinContext extracts titleByLocale + noise fields and refuses the garbage pin end-to-end', () => {
      const job = {
        sourceLang: 'de',
        titleByLocale: ctx.titleByLocale,
        company: 'Kantonsspital Aarau (KSA)',
        addressLocality: 'Aarau',
        slugDisambiguator: '',
      };
      expect(sourceSlugPinContext(job, 'de')).toEqual({
        titleByLocale: ctx.titleByLocale,
        company: 'Kantonsspital Aarau (KSA)',
        location: 'Aarau',
        disambiguator: '',
      });
      expect(registryPinnedLocaleSlug(GARBLED, 'de', 'it', sourceSlugPinContext(job, 'de'))).toBeNull();
    });
  });
});
