import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropStaleLocaleDescriptions, sourceLangOfBody } from '../scripts/lib/source-locale-slots.mjs';
import { buildAristonLocalizedContent } from '../scripts/lib/ariston-job-parser.mjs';
import { buildBoschLocalizedContent } from '../scripts/lib/bosch-job-parser.mjs';
import { buildSkyguideLocalizedContent } from '../scripts/lib/skyguide-job-parser.mjs';
import { buildSunriseLocalizedContent } from '../scripts/lib/sunrise-job-parser.mjs';
import { buildDamianiLocalizedContent } from '../scripts/lib/damiani-job-parser.mjs';
import { buildAgroscopeLocalizedContent } from '../scripts/lib/agroscope-job-parser.mjs';
import { buildPwcLocalizedContent } from '../scripts/lib/pwc-job-parser.mjs';
import { buildHitachiEnergyLocalizedContent } from '../scripts/lib/hitachi-energy-job-parser.mjs';
import { buildGiorgioArmaniLocalizedContent } from '../scripts/lib/giorgio-armani-job-parser.mjs';
import { buildPizzarottiLocalizedContent } from '../scripts/lib/pizzarotti-job-parser.mjs';
import { buildBoardLocalizedContent } from '../scripts/lib/board-job-parser.mjs';

// Pinned: one published job per crawler (main slice, 2026-09-29) — its
// source-slot body, language and published slug map (#5253).
const samples = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-quality-f', 'source-locale-slots-samples.json'),
  'utf8',
));

type Sample = { sourceLang: string, title: string, location: string, description: string, slugByLocale: Record<string, string> };
type Localized = { sourceLang: string, titleByLocale: Record<string, string>, descriptionByLocale: Record<string, string>, slugByLocale: Record<string, string> };

const builders: Array<[string, (s: Sample) => Localized, string[]]> = [
  // [crawler, builder, slug locales the builder has always emitted]
  ['ariston', (s) => buildAristonLocalizedContent({ title: s.title, location: s.location, description: s.description }), ['it', 'en', 'de', 'fr']],
  ['bosch', (s) => buildBoschLocalizedContent({ title: s.title, location: s.location, description: s.description }), ['it', 'en', 'de', 'fr']],
  ['skyguide', (s) => buildSkyguideLocalizedContent({ title: s.title, location: s.location, description: s.description }), [samples.skyguide.sourceLang]],
  ['sunrise', (s) => buildSunriseLocalizedContent({ title: s.title, location: s.location, description: s.description, sourceLangHint: 'en' }), ['it', 'en', 'de', 'fr']],
  ['damiani', (s) => buildDamianiLocalizedContent({ title: s.title, location: s.location, description: s.description }), ['it', 'en', 'de', 'fr']],
  ['agroscope', (s) => buildAgroscopeLocalizedContent({ title: s.title, city: s.location, description: s.description, language: 'it' }), ['it', 'en', 'de', 'fr']],
  ['hitachi', (s) => buildHitachiEnergyLocalizedContent({ title: s.title, location: s.location, description: s.description }), ['it', 'en', 'de', 'fr']],
  ['giorgio-armani', (s) => buildGiorgioArmaniLocalizedContent({ title: s.title, location: s.location, description: s.description }, 'Giorgio Armani'), [samples['giorgio-armani'].sourceLang]],
  ['pwc', (s) => buildPwcLocalizedContent({ title: s.title, city: s.location, description: s.description, language: 'en' }), ['it', 'en', 'de', 'fr']],
];

describe('source-locale slots of the dedicated builders (#5253)', () => {
  it.each(builders)('%s files the body under the language it is written in, and nowhere else', (key, build, slugLocales) => {
    const sample: Sample = samples[key];
    const localized = build(sample);
    expect(localized.sourceLang).toBe(sample.sourceLang);
    expect(sample.sourceLang).not.toBe('it');
    expect(Object.keys(localized.descriptionByLocale)).toEqual([sample.sourceLang]);
    expect(localized.descriptionByLocale[sample.sourceLang]).toBe(sample.description);
    expect(localized.descriptionByLocale.it).toBeUndefined();
    expect(localized.titleByLocale[sample.sourceLang]).toBeTruthy();
    expect(Object.keys(localized.slugByLocale).sort()).toEqual([...slugLocales].sort());
  });
});

describe('buildPizzarottiLocalizedContent', () => {
  it('keeps an Italian ad under it and files any other language under its own slot', () => {
    const italian = buildPizzarottiLocalizedContent({ title: 'Capo cantiere', location: 'Lugano', description: 'Cerchiamo un capo cantiere con esperienza per i nostri progetti infrastrutturali in Ticino.' });
    expect(italian.sourceLang).toBe('it');
    expect(Object.keys(italian.descriptionByLocale)).toEqual(['it']);
    const german = buildPizzarottiLocalizedContent({ title: 'Bauführer', location: 'Zürich', description: samples.agroscope.description });
    expect(german.sourceLang).toBe('de');
    expect(Object.keys(german.titleByLocale)).toEqual(['de']);
    expect(german.slugByLocale).toEqual({ de: german.slug });
  });
});

describe('buildBoardLocalizedContent', () => {
  it('files the ad under the language of its body instead of a fixed en', () => {
    const english = buildBoardLocalizedContent({ title: 'Solution Architect', location: 'Chiasso', description: samples.pwc.description });
    expect(english.sourceLang).toBe('en');
    expect(english.descriptionByLocale).toEqual({ en: samples.pwc.description });
    const italian = buildBoardLocalizedContent({ title: 'Consulente', location: 'Chiasso', description: 'Cerchiamo un consulente con esperienza per i nostri progetti di pianificazione finanziaria in Ticino.' });
    expect(italian.sourceLang).toBe('it');
    expect(Object.keys(italian.titleByLocale)).toEqual(['it']);
    expect(italian.slugByLocale).toEqual({ it: italian.slug });
  });
});

describe('sourceLangOfBody', () => {
  it('reads the body of each pinned sample as its published source language', () => {
    for (const key of Object.keys(samples).filter((k) => k !== '_note')) {
      expect(sourceLangOfBody(samples[key].description, 'it')).toBe(samples[key].sourceLang);
    }
  });

  it('falls back to the portal language when there is no body (a title is not evidence)', () => {
    expect(sourceLangOfBody('', 'en')).toBe('en');
    expect(sourceLangOfBody('   ', 'de')).toBe('de');
    expect(sourceLangOfBody('', 'xx')).toBe('it');
  });
});

describe('dropStaleLocaleDescriptions', () => {
  const german = samples.agroscope.description;
  const english = samples.pwc.description;

  it('drops copies of the source and slots written in another language, and flags retranslation', () => {
    const job = { sourceLang: 'de', description: german, descriptionByLocale: { de: german, it: german, fr: english } };
    expect(dropStaleLocaleDescriptions(job).sort()).toEqual(['fr', 'it']);
    expect(job.descriptionByLocale).toEqual({ de: german });
    expect(job.needsRetranslation).toBe(true);
  });

  it('keeps short slots it cannot classify and leaves the flag alone when nothing is stale', () => {
    const job = { sourceLang: 'de', descriptionByLocale: { de: german, it: 'Breve testo.' } };
    expect(dropStaleLocaleDescriptions(job)).toEqual([]);
    expect(job).not.toHaveProperty('needsRetranslation');
  });

  it('is a no-op without a source language or a locale map', () => {
    expect(dropStaleLocaleDescriptions({ descriptionByLocale: { it: german } })).toEqual([]);
    expect(dropStaleLocaleDescriptions({ sourceLang: 'de' })).toEqual([]);
  });
});
