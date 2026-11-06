/**
 * Tests for scripts/clean-registry-source-copies.mjs — the one-shot bonifica of
 * slug-registry entries frozen pre-translation (source-copy pins,
 * #3785/#3794/#3844/#3852/#3874 follow-up).
 *
 * The removal criterion must stay STRICTLY NARROWER than
 * registryPinnedLocaleSlug's unknown-source rule: only cross-locale copies that
 * also equal the immutable canonicalSlug are removed; every other duplicate
 * (possible legit source slot, coincidentally-identical real translations) is
 * skipped and counted, and entries are never deleted.
 */
import { describe, expect, it } from 'vitest';
import { cleanRegistrySourceCopies } from '../scripts/clean-registry-source-copies.mjs';

const RAW = 'berufswahlpraktikum-dentalassistent-dentalassistentin-ksa-ch';

describe('cleanRegistrySourceCopies', () => {
  it('removes all locale slots of a KSA-style all-copies entry (value == canonicalSlug) but keeps the entry', () => {
    const registry = {
      'id|umantis.com|4698': {
        canonicalSlug: RAW,
        canton: 'AG',
        createdAt: '2026-07-09',
        slugByLocale: { de: RAW, it: RAW, en: RAW, fr: RAW },
      },
    };
    const stats = cleanRegistrySourceCopies(registry);
    expect(stats.poisonedEntries).toBe(1);
    expect(stats.slotsRemoved).toBe(4);
    const entry = registry['id|umantis.com|4698'];
    expect(entry).toBeDefined();
    expect(entry.canonicalSlug).toBe(RAW); // canonical (master) slug untouched
    expect(entry.canton).toBe('AG');
    expect(Object.keys(entry.slugByLocale)).toHaveLength(0);
  });

  it('removes only the copy slots equal to canonicalSlug and keeps unique real translations', () => {
    const registry = {
      'id|admin.ch|x1': {
        canonicalSlug: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
        canton: 'BE',
        createdAt: '2026-06-11',
        slugByLocale: {
          de: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
          en: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
          fr: 'architecte-principal-in-sgc-1196-confederazione-svizzera-zollikofen',
          it: 'architetto-capo-sgc-1196-confederazione-svizzera-zollikofen',
        },
      },
    };
    const stats = cleanRegistrySourceCopies(registry);
    expect(stats.slotsRemoved).toBe(2);
    expect(registry['id|admin.ch|x1'].slugByLocale).toEqual({
      fr: 'architecte-principal-in-sgc-1196-confederazione-svizzera-zollikofen',
      it: 'architetto-capo-sgc-1196-confederazione-svizzera-zollikofen',
    });
  });

  it('skips (and counts) duplicate groups whose value differs from canonicalSlug — the halfCopied ambiguity', () => {
    // Shape from tests/registry-pinned-locale-slug.test.ts `halfCopied`: de is
    // a legitimate pin once sourceLang is known; removing it would lose it.
    const registry = {
      'id|admin.ch|e1a55ed6': {
        canonicalSlug: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
        canton: 'BE',
        createdAt: '2026-06-11',
        slugByLocale: {
          de: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
          it: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
          en: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
          fr: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
        },
      },
    };
    const before = JSON.parse(JSON.stringify(registry));
    const stats = cleanRegistrySourceCopies(registry);
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.poisonedEntries).toBe(0);
    expect(stats.ambiguousEntriesSkipped).toBe(1);
    expect(stats.ambiguousSlotsSkipped).toBe(3);
    expect(registry).toEqual(before); // untouched
  });

  it('leaves fully-translated entries (distinct per-locale slugs) alone', () => {
    const registry = {
      'id|upd.ch|1': {
        canonicalSlug: 'psicologo-a-assistente-upd-bern',
        canton: 'BE',
        createdAt: '2026-05-01',
        slugByLocale: {
          it: 'psicologo-a-assistente-upd-bern',
          en: 'assistant-psychologist-upd-bern',
          de: 'assistenzpsychologin-upd-bern',
          fr: 'psychologue-assistant-e-upd-bern',
        },
      },
    };
    const before = JSON.parse(JSON.stringify(registry));
    const stats = cleanRegistrySourceCopies(registry);
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.ambiguousEntriesSkipped).toBe(0);
    expect(registry).toEqual(before);
  });

  it('never crashes on malformed entries (null entry, missing slugByLocale, empty canonicalSlug)', () => {
    const registry = {
      a: null,
      b: { canonicalSlug: 'x' },
      c: { canonicalSlug: '', slugByLocale: { it: 'same', en: 'same' } },
    } as Record<string, unknown>;
    const stats = cleanRegistrySourceCopies(registry);
    // Empty canonicalSlug → cannot certify the copies as frozen raw slugs → skip.
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.ambiguousSlotsSkipped).toBe(2);
    expect((registry.c as { slugByLocale: object }).slugByLocale).toEqual({ it: 'same', en: 'same' });
  });
});
