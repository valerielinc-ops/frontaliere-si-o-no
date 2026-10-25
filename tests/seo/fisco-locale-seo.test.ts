import { describe, expect, it } from 'vitest';

import {
  FISCO_LOCALE_SEO_SOURCE_PATHS,
  resolveFiscoLocaleSeo,
  resolveFiscoLocaleSeoByPath,
} from '../../build-plugins/shared/fiscoLocaleSeo';
import {
  buildTitleWithBrand,
  META_DESCRIPTION_MAX_CHARS,
  TITLE_MAX_CHARS,
} from '../../build-plugins/shared/titleSuffix';

describe('localized Tax & Pension SEO metadata', () => {
  it('covers every localized family route in all non-Italian locales', () => {
    expect(FISCO_LOCALE_SEO_SOURCE_PATHS).toHaveLength(13);

    for (const locale of ['en', 'de', 'fr']) {
      for (const sourcePath of FISCO_LOCALE_SEO_SOURCE_PATHS) {
        const metadata = resolveFiscoLocaleSeoByPath(sourcePath, locale);
        expect(metadata, `${locale} ${sourcePath}: missing localized metadata`).toBeTruthy();
        expect(metadata!.title.length, `${locale} ${sourcePath}: title`).toBeLessThanOrEqual(TITLE_MAX_CHARS);
        expect(buildTitleWithBrand(metadata!.title).length, `${locale} ${sourcePath}: branded title`)
          .toBeLessThanOrEqual(TITLE_MAX_CHARS);
        expect(metadata!.description.length, `${locale} ${sourcePath}: description`)
          .toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
        expect(metadata!.description.length, `${locale} ${sourcePath}: thin description`)
          .toBeGreaterThan(50);
      }
    }
  });

  it('resolves the four reported routes to intent-specific copy', () => {
    expect(resolveFiscoLocaleSeoByPath('/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/', 'de'))
      .toMatchObject({ title: 'Quellensteuer Tessin 2026' });
    expect(resolveFiscoLocaleSeoByPath('/tasse-e-pensione/calcola-previdenza/', 'en'))
      .toMatchObject({ title: 'Cross-Border Pension Planner' });
    expect(resolveFiscoLocaleSeoByPath('/tasse-e-pensione/festivita-ticino/', 'de'))
      .toMatchObject({ title: 'Feiertage Tessin 2026' });
    expect(resolveFiscoLocaleSeoByPath('/tasse-e-pensione/dichiarazione-redditi/', 'fr'))
      .toMatchObject({ title: 'Guide de la déclaration fiscale' });
  });

  it('does not reinterpret an unknown family section or Italian runtime', () => {
    expect(resolveFiscoLocaleSeo('not-a-fisco-section', 'en')).toBeNull();
    expect(resolveFiscoLocaleSeo('fisco', 'it')).toBeNull();
    expect(resolveFiscoLocaleSeoByPath('/tasse-e-pensione/non-existent/', 'en')).toBeNull();
  });
});
