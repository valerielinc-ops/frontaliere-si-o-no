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
    // Without a source language we cannot detect source copies, so any present
    // per-locale slug is treated as authoritative.
    expect(registryPinnedLocaleSlug(REGISTERED, 'en', null)).toBe(
      'assistant-psychologist-or-specialist-psychologist-upd-bern',
    );
  });
});
