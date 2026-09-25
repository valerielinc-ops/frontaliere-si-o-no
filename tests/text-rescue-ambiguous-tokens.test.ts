import { describe, expect, it } from 'vitest';
import { isLocationExplicitlyForeign } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  TEXT_RESCUE_AMBIGUOUS_TOKENS,
  findSwissCityInText,
  isCantonRelevant,
  isKnownSwissCity,
  inferAnyCanton,
  rescueSwissCityFromText,
  swissCityFromLocationField,
} from '../scripts/lib/target-swiss-locations.mjs';

/**
 * Regression guard for #5136.
 *
 * The weekly location audit (run 31001482058) reported 2404 jobs whose
 * published canton contradicted the crawler's own record. Cross-joining the
 * per-job report against data/jobs/by-crawler/ showed 1592 of them had had
 * their LOCALITY rewritten by the assemble step's description-text rescue:
 * it scanned the description for a Swiss city name and matched everyday words
 * that happen to name tiny municipalities. Roche postings in Jakarta, Kyiv and
 * Michigan all shipped as "Alle" (JU) — German "alle" = "all".
 *
 * Every BFS-backed row of that audit signed those jobs off as correct, because
 * "Alle" IS a real municipality. Only the crawler-record comparison caught it.
 */
describe('text-rescue ambiguous token guard (#5136)', () => {
  it('does not manufacture a city from an everyday word in description text', () => {
    // The exact strings that shipped ~1.4k jobs to the wrong canton.
    expect(rescueSwissCityFromText('Wir freuen uns auf alle Bewerbungen')).toBe('');
    expect(rescueSwissCityFromText('Ihre Rolle in unserem Team')).toBe('');
    expect(rescueSwissCityFromText('Le lieu de travail est flexible')).toBe('');
    expect(rescueSwissCityFromText('This is a fully remote position')).toBe('');
    expect(rescueSwissCityFromText('cause-root analysis and root cause fixes')).toBe('');
    expect(rescueSwissCityFromText('Wir sind an allen Messen vertreten')).toBe('');
    expect(rescueSwissCityFromText('Das Projekt wird laufen bis 2027')).toBe('');
    expect(rescueSwissCityFromText('research on the thyroid gland')).toBe('');
    expect(rescueSwissCityFromText('a few hundred meilen away')).toBe('');
  });

  it('still rescues a genuine city named in the description', () => {
    expect(rescueSwissCityFromText('Unser Standort in Winterthur')).toBe('Winterthur');
    expect(rescueSwissCityFromText('La sede si trova a Lugano')).toBe('Lugano');
    expect(rescueSwissCityFromText('Arbeitsort: Fribourg')).toBe('Fribourg');
    expect(rescueSwissCityFromText('sede a Bellinzona')).toBe('Bellinzona');
  });

  it('keeps scanning past a blocked token instead of giving up', () => {
    // A skipped token must not abort the search — otherwise blocking "alle"
    // would silently destroy the rescue for every German description.
    expect(rescueSwissCityFromText('alle Mitarbeitenden in Winterthur willkommen')).toBe('Winterthur');
    expect(rescueSwissCityFromText('Ihre Rolle am Standort Lugano')).toBe('Lugano');
  });

  it('leaves an EXPLICIT locality field resolving normally', () => {
    // The blocklist is scoped to free-text rescue only. "Rolle" typed into
    // addressLocality is a real Vaud town the author meant; blocking it
    // globally would drop legitimate jobs and break isCantonRelevant.
    for (const [city, canton] of [
      ['Rolle', 'VD'], ['Fully', 'VS'], ['Alle', 'JU'],
      ['Root', 'LU'], ['Bulle', 'FR'], ['Laufen', 'BL'],
      ['Gland', 'VD'], ['Meilen', 'ZH'],
    ] as const) {
      expect(isKnownSwissCity(city), `isKnownSwissCity(${city})`).toBe(true);
      expect(inferAnyCanton(city), `inferAnyCanton(${city})`).toBe(canton);
      expect(isCantonRelevant(city, canton), `isCantonRelevant(${city}, ${canton})`).toBe(true);
    }
  });

  it('applies the blocklist only when the caller asks for it', () => {
    // Raw findSwissCityInText is still used on explicit locality fields.
    expect(findSwissCityInText('Rolle')).toBe('rolle');
    expect(findSwissCityInText('Rolle', { skipTokens: TEXT_RESCUE_AMBIGUOUS_TOKENS })).toBe('');
  });

  it('swissCityFromLocationField reads a location field WITHOUT the blocklist', () => {
    // The location-field companion: same extraction, opposite policy. Keeping
    // the two as named functions is what stops a call site from silently
    // picking the wrong one by inlining the raw expression.
    expect(swissCityFromLocationField('Rolle')).toBe('Rolle');
    expect(swissCityFromLocationField('Baden, Aargau')).toBe('Baden');
    expect(swissCityFromLocationField('2540 Grenchen Phone')).toBe('Grenchen');
    expect(swissCityFromLocationField('Jakarta')).toBe('');
    // Same input, opposite verdicts — that is the whole point of the split.
    expect(rescueSwissCityFromText('Rolle')).toBe('');
  });

  it('reads words with Unicode boundaries, so a non-ASCII letter does not split a word (#9846)', () => {
    // ASCII folding turned "Großdietwil" (Grossdietwil, LU, in German-German
    // spelling) into "gro dietwil", i.e. Dietwil in canton Aargau.
    expect(rescueSwissCityFromText('Arbeitsort Großdietwil')).toBe('');
    expect(rescueSwissCityFromText('Arbeitsort Grossdietwil')).toBe('Grossdietwil');
  });

  it('never reads the company name Hoffmann-La Roche as La Roche (FR) (#9846)', () => {
    expect(rescueSwissCityFromText('an existing vacancy at Hoffmann-La Roche Ltd.')).toBe('');
    expect(rescueSwissCityFromText('presso la Roche Boarding House')).toBe('');
  });

  describe('foreign context: the caller\'s locality names no Swiss place (#9846)', () => {
    // The assembler passes isLocationExplicitlyForeign as the list guard's
    // gazetteer.
    const abroad = (text: string) => rescueSwissCityFromText(text, {
      foreignContext: true,
      isForeignPlace: isLocationExplicitlyForeign,
    });

    it('skips a municipality inside a foreign hyphenated compound', () => {
      expect(abroad('Duale Hochschule Baden-Württemberg in Mannheim')).toBe('');
      // A Swiss compound keeps its match.
      expect(abroad('Kanton Basel-Stadt')).toBe('Basel');
      expect(abroad('Standort Zürich-Oerlikon')).toBe('Zürich');
      // Outside the foreign context a municipality-locality compound is Swiss.
      expect(rescueSwissCityFromText('Standort Baden-Dättwil')).toBe('Baden');
    });

    it('skips articles and common words, i.e. a name not written as a proper noun', () => {
      expect(abroad('i requisiti di reporting tenero')).toBe('');
      expect(abroad('Vind je het leuk om te werken')).toBe('');
      expect(abroad('Arbeitsort: Tenero')).toBe('Tenero');
      expect(abroad('Arbeitsort: ZÜRICH')).toBe('Zürich');
      // An e-mail address or URL is lower case whatever it names.
      expect(abroad('CV a: fisiocare.lugano@gmail.com')).toBe('Lugano');
    });

    it('skips the employer\'s headquarters', () => {
      expect(abroad('Sulzer, mit Hauptsitz in Winterthur, Schweiz')).toBe('');
      expect(abroad('with headquarters in Winterthur, Switzerland')).toBe('');
      expect(abroad('leader globale con sede a Winterthur, in Svizzera')).toBe('');
      expect(abroad('avec son siège à Winterthur, en Suisse')).toBe('');
      expect(abroad('Sede di lavoro: Winterthur')).toBe('Winterthur');
      // Outside the foreign context the same sentence still rescues.
      expect(rescueSwissCityFromText('con sede a Winterthur')).toBe('Winterthur');
    });

    it('skips one entry of a list of sites that names a place abroad', () => {
      expect(abroad('With offices across Geneva, Zurich, Barcelona, London and more')).toBe('');
      expect(abroad('Avec des bureaux à Genève, Zurich, Barcelone, Londres')).toBe('');
      expect(abroad('(u. a. Penzberg, Basel, Oceanside, Vacaville und South San Francisco)')).toBe('');
      // A list of Swiss sites only still places the job in Switzerland.
      expect(abroad('mit den Standorten Luzern, Sursee und Wolhusen')).toBe('Luzern');
      expect(abroad('the Diagnostics Partnering group in Basel / Rotkreuz has')).toBe('Basel');
    });
  });

  it('blocks every token as a bare description word', () => {
    // Guards against a token being added to the set but shadowed by a
    // multi-word alias, which would leave it silently live.
    for (const token of TEXT_RESCUE_AMBIGUOUS_TOKENS) {
      expect(rescueSwissCityFromText(token), `bare token: ${token}`).toBe('');
    }
  });
});
