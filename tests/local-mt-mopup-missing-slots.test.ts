import { describe, it, expect } from 'vitest';
import { missingSlots } from '../scripts/local-mt-mopup.mjs';

describe('local-mt-mopup missingSlots()', () => {
  it('flags a title slot that is present but still lexically German (compound-residue) — issue #6354', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Aiuto Metzger 60-100%',
        en: 'Assistant Butcher 60-100%',
        fr: 'Aide boucher 60-100%',
      },
      descriptionByLocale: {},
    };

    const slots = missingSlots(job);
    expect(slots).toContainEqual({ locale: 'it', field: 'title' });
    // The already-clean en/fr slots must not be touched.
    expect(slots).not.toContainEqual({ locale: 'en', field: 'title' });
    expect(slots).not.toContainEqual({ locale: 'fr', field: 'title' });
  });

  it('still flags an exact source-copy title (pre-existing behaviour, unchanged)', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Metzger 60-100%',
      },
      descriptionByLocale: {},
    };

    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
  });

  it('does not flag a clean, fully-translated title', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Macellaio 60-100%',
        en: 'Butcher 60-100%',
        fr: 'Boucher 60-100%',
      },
      descriptionByLocale: {},
    };

    expect(missingSlots(job)).toEqual([]);
  });
});
