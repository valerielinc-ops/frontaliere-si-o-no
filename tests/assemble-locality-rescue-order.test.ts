import { describe, expect, it } from 'vitest';
import {
  canonicalSwissCityName,
  findSwissCityInText,
  rescueSwissCityFromText,
} from '../scripts/lib/target-swiss-locations.mjs';

/**
 * Regression guard for #5136, assemble side.
 *
 * scripts/assemble-jobs-dataset.mjs resolves a job whose primary locality is
 * neither a known Swiss city nor a canton-only label with:
 *
 *   canonicalSwissCityName(findSwissCityInText(primaryLoc)) || rescueSwissCityFromText(haystack)
 *
 * The ORDER is the fix. The locality field usually still contains the true city
 * behind a suffix that stopped isKnownSwissCity from matching the whole string
 * ("Geneva, Switzerland", "Baden, Aargau", "Luzern / hybrid"). Consulting the
 * description first — what the code used to do — published those as Root (LU)
 * and Alle (JU). Replaying the audit join over data/jobs/by-crawler/ showed
 * this ordering alone restores the correct canton for 263 jobs.
 */
const resolveLocality = (primaryLoc: string, haystack: string) =>
  canonicalSwissCityName(findSwissCityInText(primaryLoc)) || rescueSwissCityFromText(haystack);

describe('assemble locality rescue order (#5136)', () => {
  it('recovers the city from a decorated locality instead of the description', () => {
    // Real localities from data/jobs/by-crawler/, with a description that
    // would otherwise hijack them (the German "alle" → Alle/JU).
    const hijackingDescription = 'Wir freuen uns auf alle Bewerbungen aus der ganzen Schweiz';
    const cases: Array<[string, string]> = [
      ['Baden, Aargau', 'Baden'],
      ['Dietikon, Zürich', 'Dietikon'],
      ['Bellinzona, Ticino', 'Bellinzona'],
      ['Luzern / hybrid', 'Luzern'],
      ['2540 Grenchen Phone', 'Grenchen'],
      ['Visp-Eyholz', 'Visp'],
      ['Pratteln 1', 'Pratteln'],
      ['Bern-Brünnen', 'Bern'],
      ['Matran - Mad 4', 'Matran'],
      ['Schaffhausen Mitarbeiterin Verkauf Haushalt', 'Schaffhausen'],
    ];
    for (const [primaryLoc, expected] of cases) {
      expect(resolveLocality(primaryLoc, hijackingDescription), primaryLoc).toBe(expected);
    }
  });

  it('documents the English-exonym gap that this fix does NOT close', () => {
    // "Geneva" is not registered as a BFS alias for Genève, so a locality of
    // "Geneva, Switzerland" still yields no city and falls through to the
    // description. Before this fix those postings shipped as Root (LU) / Alle
    // (JU); the token blocklist now stops that, but they are rescued by
    // whatever city the description names rather than by Genève. Registering
    // English exonyms is a separate change with a much wider blast radius
    // (isKnownSwissCity is consumed by every crawler validator), so it is
    // tracked here rather than smuggled into this one.
    expect(resolveLocality('Geneva, Switzerland', '')).toBe('');
  });

  it('manufactures nothing for a foreign locality whose description is boilerplate', () => {
    // The Roche signature: a posting the crawler recorded abroad, whose German
    // description contains "alle". It must NOT become a Swiss job. Returning ''
    // makes acceptBadLocalityViaCanton's text branch fail, so the record is
    // dropped rather than published under a Swiss canton it never belonged to.
    const german = 'Wir freuen uns auf alle Bewerbungen und Ihre Rolle im Team';
    for (const foreign of ['Jakarta', 'Kyiv', 'Michigan', 'Mississauga', 'Petaling Jaya', 'Bratislava, SK']) {
      expect(resolveLocality(foreign, german), foreign).toBe('');
    }
  });

  it('still falls back to the description when the locality yields nothing', () => {
    expect(resolveLocality('Standortübergreifend', 'Unser Büro in Winterthur')).toBe('Winterthur');
  });
});
