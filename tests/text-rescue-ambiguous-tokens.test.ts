import { describe, expect, it } from 'vitest';
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

  it('blocks every token as a bare description word', () => {
    // Guards against a token being added to the set but shadowed by a
    // multi-word alias, which would leave it silently live.
    for (const token of TEXT_RESCUE_AMBIGUOUS_TOKENS) {
      expect(rescueSwissCityFromText(token), `bare token: ${token}`).toBe('');
    }
  });
});
