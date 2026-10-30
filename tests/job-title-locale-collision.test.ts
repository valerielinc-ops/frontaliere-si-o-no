import { describe, expect, it } from 'vitest';
import { jobTitleLocaleKeys, jobTitleLocaleQualifiers } from '../build-plugins/shared/jobTitleLocaleCollision';
import { composeSerpJobTitle, finalizeJobBoardTitle, TITLE_MAX_CHARS } from '../build-plugins/shared/titleSuffix';
import { buildActiveJobPageInput, buildActiveJobPageReuseInput, computeInputHash } from '../build-plugins/shared/incrementalManifest.mjs';

const locales = ['it', 'en', 'de', 'fr'] as const;
const escapedLength = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').length;

describe('job title collisions across rendered locale variants', () => {
  it('invalidates published and reused HTML when another locale creates a new collision', () => {
    const input = { job: { title: 'Developer', company: 'Example' }, locale: 'en', slug: 'developer-example' };
    const clean = buildActiveJobPageInput(input);
    const qualified = buildActiveJobPageInput({ ...input, titleLocaleQualifier: 'English' });
    for (const project of [(value: unknown) => value, buildActiveJobPageReuseInput]) {
      expect(computeInputHash(project(clean), 'active-job')).not.toBe(computeInputHash(project(qualified), 'active-job'));
    }
  });
  it('detects the audit collision created by dropping a localized city connector', () => {
    const identity = ['Impiegato tecnico amministrativo', 'TPL Trasporti Pubblici Luganesi', 'Lugano'] as const;
    const probes = locales.map((locale) => jobTitleLocaleKeys(...identity, locale, escapedLength));
    expect(probes[0][0]).not.toBe(probes[1][0]);
    expect(new Set(probes.map((keys) => keys[1])).size).toBe(1);
    expect(jobTitleLocaleQualifiers(...identity, escapedLength)).toEqual({ en: 'English', de: 'Deutsch', fr: 'Français' });
  });

  it.each([
    ['Impiegato tecnico amministrativo', 'TPL Trasporti Pubblici Luganesi', 'Lugano'],
    ['Boutique Assistant Intern', 'Cartier', 'Lugano'],
    ['Apprendistato come impiegata/-o di commercio AFC Banca', 'La Posta Svizzera', 'Lugano'],
    ['Ricerca & sviluppo <sistemi> con responsabilità internazionali', 'A & B', 'Zürich'],
  ])('keeps all city-choice combinations unique within the escaped title budget: %s', (title, company, location) => {
    const qualifiers = jobTitleLocaleQualifiers(title, company, location, escapedLength);
    for (let mask = 0; mask < 16; mask++) {
      const titles = locales.map((locale, index) => finalizeJobBoardTitle(composeSerpJobTitle(title, company, location, locale, {
        cityOptional: Boolean(mask & (1 << index)),
        disambiguator: qualifiers[locale],
        measureLength: escapedLength,
      }), TITLE_MAX_CHARS, escapedLength));
      expect(new Set(titles.map((value) => value.toLowerCase())).size, titles.join('\n')).toBe(4);
      for (const value of titles) expect(escapedLength(value)).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    }
  });

  it('leaves genuinely different locale headlines clean and has no shard state', () => {
    const identity = ['Developer', 'Example', 'Lugano'] as const;
    expect(jobTitleLocaleQualifiers(...identity, escapedLength)).toEqual({ de: 'Deutsch' });
    const first = jobTitleLocaleQualifiers(...identity, escapedLength);
    jobTitleLocaleQualifiers('Different role', '', '', escapedLength);
    expect(jobTitleLocaleQualifiers(...identity, escapedLength)).toEqual(first);
  });
});
