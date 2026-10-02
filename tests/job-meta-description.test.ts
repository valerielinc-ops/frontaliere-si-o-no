import { describe, expect, it } from 'vitest';
import { buildJobMetaDescription } from '../build-plugins/shared/jobMetaDescription';
import {
 META_DESCRIPTION_MAX_CHARS,
 META_DESCRIPTION_MIN_CHARS,
} from '../build-plugins/shared/titleSuffix';

describe('buildJobMetaDescription', () => {
 it('keeps source context inside the 120–160 character contract', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
   const description = buildJobMetaDescription({
    locale,
    title: locale === 'it' ? 'Tecnico' : locale === 'en' ? 'Technician' : locale === 'de' ? 'Techniker' : 'Technicien',
    company: 'Acme SA',
    location: 'Lugano',
    cleanDescription: 'Descrizione breve ma utile con sede, requisiti e candidatura online.',
   });
   expect(description.length, locale).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
   expect(description.length, locale).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
   expect(description).toContain('Descrizione breve ma utile');
  }
 });

 it('adds localized context when the source record is genuinely short', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
   const description = buildJobMetaDescription({
    locale,
    title: 'Role',
    company: 'A',
    location: 'B',
   });
   expect(description.length, locale).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
   expect(description.length, locale).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
  }
 });

 it('decodes HTML entities before clamping the SERP boundary', () => {
  const description = buildJobMetaDescription({
   locale: 'en',
   title: 'Senior technician',
   company: 'A &amp; B',
   location: 'Lugano',
   cleanDescription: `${'x'.repeat(110)}&amp;quality`,
  });

  expect(description).not.toContain('&amp');
  expect(description).toContain('&quality…');
  expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
 });
});
