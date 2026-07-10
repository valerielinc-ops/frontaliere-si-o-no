/**
 * previousSlugs writer regression (#3785/#3794/#3844/#3852/#3874) —
 * registry poisoning at registration time.
 *
 * registerJobSlug used to freeze the job's slugByLocale WHOLESALE into the
 * immutable registry entry, including non-source locale slots that were still
 * byte-copies of the source slug (jobs registered before AI localization
 * finished). Production evidence: the id|umantis.com|* KSA entries created
 * 2026-07-09 (commit 90a6b422be) froze the raw DE slug across all four
 * locales; every later pin pass whose source-copy guard was weaker
 * (sourceLang missing/misdetected) then reverted real translations to those
 * frozen copies — the "full slugByLocale wipe" instance of the regression.
 *
 * Fixed contract: copies are left unregistered; backfillRegistryLocaleSlugs
 * adds each locale the first time a REAL translation exists (its documented
 * behavior, unchanged).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { registerJobSlug } from '../scripts/lib/dedicated-crawler-common.mjs';

const URL = 'https://recruitingapp-122706.umantis.com/Vacancies/4698/Application/CheckLogin/1';

describe('registerJobSlug source-copy filtering', () => {
  let registry: Record<string, any>;
  beforeEach(() => { registry = {}; });

  it('does not freeze non-source locales that copy the source slug (known sourceLang)', () => {
    registerJobSlug({
      url: URL,
      slug: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
      sourceLang: 'de',
      canton: 'AG',
      slugByLocale: {
        de: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        it: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        en: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
        fr: 'stage-professionnel-au-choix-assistant-dentaire-23-07-2026-ksa',
      },
    }, registry);
    const entry = registry['id|recruitingapp-122706.umantis.com|4698'];
    expect(entry).toBeTruthy();
    expect(entry.canonicalSlug).toBe('berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch');
    // Source locale is kept; untranslated copies are NOT frozen; the real
    // translation (fr) is kept.
    expect(entry.slugByLocale).toEqual({
      de: 'berufswahlpraktikum-dentalassistent-dentalassistentin-23-07-2026-ksa-ch',
      fr: 'stage-professionnel-au-choix-assistant-dentaire-23-07-2026-ksa',
    });
  });

  it('with unknown sourceLang, freezes only locales whose value is unique', () => {
    registerJobSlug({
      url: URL,
      slug: 'raw-slug-everywhere',
      canton: 'AG',
      slugByLocale: {
        de: 'raw-slug-everywhere',
        it: 'raw-slug-everywhere',
        en: 'raw-slug-everywhere',
        fr: 'vrai-slug-traduit-fr',
      },
    }, registry);
    const entry = registry['id|recruitingapp-122706.umantis.com|4698'];
    expect(entry.slugByLocale).toEqual({ fr: 'vrai-slug-traduit-fr' });
  });

  it('keeps fully-translated entries intact (no behavior change)', () => {
    const slugByLocale = {
      de: 'assistenzpsychologin-upd-bern',
      it: 'psicologo-assistente-upd-bern',
      en: 'assistant-psychologist-upd-bern',
      fr: 'psychologue-assistant-upd-bern',
    };
    registerJobSlug({
      url: URL,
      slug: 'psicologo-assistente-upd-bern',
      sourceLang: 'de',
      canton: 'BE',
      slugByLocale,
    }, registry);
    expect(registry['id|recruitingapp-122706.umantis.com|4698'].slugByLocale).toEqual(slugByLocale);
  });

  it('still never overwrites an existing entry (immutability unchanged)', () => {
    registry['id|recruitingapp-122706.umantis.com|4698'] = { canonicalSlug: 'frozen', slugByLocale: { it: 'frozen' } };
    registerJobSlug({ url: URL, slug: 'new-slug', slugByLocale: { it: 'new-slug' } }, registry);
    expect(registry['id|recruitingapp-122706.umantis.com|4698'].canonicalSlug).toBe('frozen');
  });
});
