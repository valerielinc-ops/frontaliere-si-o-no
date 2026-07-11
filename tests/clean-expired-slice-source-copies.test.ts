/**
 * Tests for scripts/clean-expired-slice-source-copies.mjs — the one-shot
 * bonifica of poisoned slugByLocale copies frozen inside
 * data/jobs/expired/by-crawler/<key>.json (item 1 of follow-up #4057).
 *
 * Mirrors tests/clean-registry-source-copies.test.ts: the removal criterion
 * must stay STRICTLY NARROWER than registryPinnedLocaleSlug's unknown-source
 * rule — only cross-locale copies that also equal the job's own `slug` are
 * removed; every other duplicate is skipped and counted, and entries are
 * never deleted.
 */
import { describe, expect, it } from 'vitest';
import { cleanExpiredSliceSourceCopies } from '../scripts/clean-expired-slice-source-copies.mjs';

const RAW = 'berufswahlpraktikum-dentalassistent-dentalassistentin-ksa-ch';

describe('cleanExpiredSliceSourceCopies', () => {
  it('removes all locale slots of a KSA-style all-copies entry (value == slug) but keeps the entry', () => {
    const slice = [
      {
        slug: RAW,
        title: 'Berufswahlpraktikum',
        company: 'KSA',
        expiredAt: '2026-07-09T00:00:00.000Z',
        slugByLocale: { de: RAW, it: RAW, en: RAW, fr: RAW },
      },
    ];
    const stats = cleanExpiredSliceSourceCopies(slice);
    expect(stats.poisonedEntries).toBe(1);
    expect(stats.slotsRemoved).toBe(4);
    expect(slice).toHaveLength(1); // entry never deleted
    expect(slice[0].slug).toBe(RAW); // master slug untouched
    expect(slice[0].title).toBe('Berufswahlpraktikum');
    expect(Object.keys(slice[0].slugByLocale)).toHaveLength(0);
  });

  it('removes only the copy slots equal to slug and keeps unique real translations', () => {
    const slice = [
      {
        slug: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
        company: 'Confederazione',
        expiredAt: '2026-06-11T00:00:00.000Z',
        slugByLocale: {
          de: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
          en: 'lead-architekt-in-sgc-1196-confederazione-zollikofen',
          fr: 'architecte-principal-in-sgc-1196-confederazione-svizzera-zollikofen',
          it: 'architetto-capo-sgc-1196-confederazione-svizzera-zollikofen',
        },
      },
    ];
    const stats = cleanExpiredSliceSourceCopies(slice);
    expect(stats.slotsRemoved).toBe(2);
    expect(slice[0].slugByLocale).toEqual({
      fr: 'architecte-principal-in-sgc-1196-confederazione-svizzera-zollikofen',
      it: 'architetto-capo-sgc-1196-confederazione-svizzera-zollikofen',
    });
  });

  it('skips (and counts) duplicate groups whose value differs from slug — the halfCopied ambiguity', () => {
    const slice = [
      {
        slug: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
        company: 'Confederazione',
        expiredAt: '2026-06-11T00:00:00.000Z',
        slugByLocale: {
          de: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
          it: 'wissenschaftliche-r-collaboratore-trice-in-provenienzforschung-confederazione-svizzera-bern',
          en: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
          fr: 'wissenschaftliche-r-mitarbeiter-in-provenienzforschung-confederazione-bern',
        },
      },
    ];
    const before = JSON.parse(JSON.stringify(slice));
    const stats = cleanExpiredSliceSourceCopies(slice);
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.poisonedEntries).toBe(0);
    expect(stats.ambiguousEntriesSkipped).toBe(1);
    expect(stats.ambiguousSlotsSkipped).toBe(3);
    expect(slice).toEqual(before); // untouched
  });

  it('leaves fully-translated entries (distinct per-locale slugs) alone', () => {
    const slice = [
      {
        slug: 'psicologo-a-assistente-upd-bern',
        company: 'UPD',
        expiredAt: '2026-05-01T00:00:00.000Z',
        slugByLocale: {
          it: 'psicologo-a-assistente-upd-bern',
          en: 'assistant-psychologist-upd-bern',
          de: 'assistenzpsychologin-upd-bern',
          fr: 'psychologue-assistant-e-upd-bern',
        },
      },
    ];
    const before = JSON.parse(JSON.stringify(slice));
    const stats = cleanExpiredSliceSourceCopies(slice);
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.ambiguousEntriesSkipped).toBe(0);
    expect(slice).toEqual(before);
  });

  it('honors a known sourceLang instead of the unknown-source duplicate rule', () => {
    // With sourceLang known, only slots equal to the SOURCE locale's slug are
    // suspected copies; an incidental cross-locale duplicate on non-source
    // locales that differs from the source slug is a legitimate pin.
    const slice = [
      {
        slug: 'raw-source-slug',
        sourceLang: 'de',
        company: 'Foo',
        expiredAt: '2026-06-01T00:00:00.000Z',
        slugByLocale: {
          de: 'raw-source-slug',
          it: 'raw-source-slug', // untranslated copy of source → removed
          en: 'real-translation',
          fr: 'real-translation', // coincidentally identical real translations → kept
        },
      },
    ];
    const stats = cleanExpiredSliceSourceCopies(slice);
    expect(stats.slotsRemoved).toBe(1);
    expect(slice[0].slugByLocale).toEqual({
      de: 'raw-source-slug',
      en: 'real-translation',
      fr: 'real-translation',
    });
  });

  it('never crashes on malformed entries (null entry, missing slugByLocale, empty slug, non-array slice)', () => {
    const slice = [
      null,
      { slug: 'x' },
      { slug: '', slugByLocale: { it: 'same', en: 'same' } },
    ];
    const stats = cleanExpiredSliceSourceCopies(slice);
    // Empty slug → cannot certify the copies as frozen raw slugs → skip.
    expect(stats.slotsRemoved).toBe(0);
    expect(stats.ambiguousSlotsSkipped).toBe(2);
    expect((slice[2] as { slugByLocale: object }).slugByLocale).toEqual({ it: 'same', en: 'same' });

    expect(cleanExpiredSliceSourceCopies(null as unknown as unknown[])).toEqual({
      entriesScanned: 0,
      poisonedEntries: 0,
      slotsRemoved: 0,
      ambiguousEntriesSkipped: 0,
      ambiguousSlotsSkipped: 0,
      samples: [],
    });
  });
});
