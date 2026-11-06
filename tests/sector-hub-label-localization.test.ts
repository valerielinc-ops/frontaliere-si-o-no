import { describe, expect, it } from 'vitest';
import { localizeSectorHubLabel } from '../scripts/lib/sector-hub-label-localization';

describe('sector hub label localization', () => {
  it('keeps curated labels and adds successful translations from the source locale', async () => {
    const labels = await localizeSectorHubLabel({
      label: 'Servizi ferroviari',
      sourceLocale: 'it',
      existingLabels: { fr: 'Services ferroviaires' },
      translate: async (_text, _sourceLocale, targetLocale) => {
        if (targetLocale === 'en') return 'Accountancy and finance';
        if (targetLocale === 'de') return 'Bahnverkehr';
        return 'Should not replace curated French';
      },
    });

    expect(labels).toEqual({
      it: 'Servizi ferroviari',
      en: 'Accountancy and finance',
      de: 'Bahnverkehr',
      fr: 'Services ferroviaires',
    });
  });

  it('publishes only the source locale when translations are unchanged or invalid', async () => {
    const labels = await localizeSectorHubLabel({
      label: 'Analisi oceanografica',
      sourceLocale: 'it',
      translate: async (_text, _sourceLocale, targetLocale) => {
        if (targetLocale === 'en') return 'Analisi oceanografica';
        if (targetLocale === 'de') return '<b>broken</b>';
        throw new Error('translation provider unavailable');
      },
    });

    expect(labels).toEqual({ it: 'Analisi oceanografica' });
  });

  it('omits a changed label when language detection confidently identifies a different locale', async () => {
    const labels = await localizeSectorHubLabel({
      label: 'Servizi ferroviari',
      sourceLocale: 'it',
      translate: async (_text, _sourceLocale, targetLocale) => {
        if (targetLocale === 'en') return 'Services ferroviaires';
        if (targetLocale === 'de') return 'Bahnverkehr';
        return 'Services ferroviaires';
      },
    });

    expect(labels).toEqual({
      it: 'Servizi ferroviari',
      de: 'Bahnverkehr',
      fr: 'Services ferroviaires',
    });
  });
});
