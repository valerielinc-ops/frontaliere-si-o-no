import { describe, expect, it } from 'vitest';
import { isSlugStable } from '../scripts/lib/dedicated-crawler-common.mjs';

/**
 * Slug stability is the merge guard that prevents minor title-wording changes
 * (e.g. "per la Ricerca" → "di ricerca") from regenerating a job's slug and
 * orphaning the old indexed URL.
 *
 * The function uses Jaccard token similarity (≥0.80 → stable). However, when
 * a company publishes the same title across multiple cities (Lidl in Biasca,
 * Locarno, Cadenazzo, …), the title tokens are identical and only the
 * trailing location segment differs. The Jaccard score on the title-heavy
 * portion easily clears 0.80, so the function used to return `true` for
 * different jobs in different cities — collapsing all of them to the same
 * slug, after which the within-slice slug dedup pass deletes 6 of 7 distinct
 * openings on every housekeeping run.
 *
 * The fix: location-aware precondition. When both slugs end with a non-empty
 * location-like segment AND those segments differ, the slugs are NOT stable,
 * regardless of Jaccard score.
 *
 * Reference: GitHub Actions run 24070266989, commit f8b2291 — Lidl Svizzera
 * apprendistato collapsed 7 cities into one slug.
 */
describe('isSlugStable — location-aware stability', () => {
  // ── Lidl regression: same title, different city ────────────────────────
  it('returns false when two long Lidl slugs differ only by trailing city (IT)', () => {
    const cadenazzo = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-cadenazzo';
    const locarno = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-locarno';
    expect(isSlugStable(cadenazzo, locarno)).toBe(false);
  });

  it('returns false when two long Lidl slugs differ only by trailing city (EN)', () => {
    const cadenazzo = 'retail-apprenticeship-cfp-or-afc-starting-2026-lidl-svizzera-cadenazzo';
    const locarno = 'retail-apprenticeship-cfp-or-afc-starting-2026-lidl-svizzera-locarno';
    expect(isSlugStable(cadenazzo, locarno)).toBe(false);
  });

  it('returns false when comparing two distinct Ticino city tails for the same role', () => {
    const biasca = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-biasca';
    const arbedoCastione = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-arbedo-castione';
    expect(isSlugStable(biasca, arbedoCastione)).toBe(false);
  });

  it('returns false when explicit locations are passed even if slugs lack a clear city tail', () => {
    // Defensive: caller can pass locations explicitly when the slug format
    // does not embed the location in the trailing segment.
    const a = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026';
    const b = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026';
    expect(
      isSlugStable(a, b, { existingLocation: 'Cadenazzo', newLocation: 'Locarno' }),
    ).toBe(false);
  });

  // ── Same job, same city: must remain stable ─────────────────────────────
  it('returns true when both slugs and locations match exactly', () => {
    const slug = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-cadenazzo';
    expect(isSlugStable(slug, slug)).toBe(true);
    expect(
      isSlugStable(slug, slug, { existingLocation: 'Cadenazzo', newLocation: 'Cadenazzo' }),
    ).toBe(true);
  });

  it('returns true for minor title wording changes when location is unchanged', () => {
    // Two variations of the same role in Cadenazzo: "di" → "per la" rewording.
    const a = 'apprendista-per-la-ricerca-clinica-lidl-svizzera-cadenazzo';
    const b = 'apprendista-di-ricerca-clinica-lidl-svizzera-cadenazzo';
    expect(isSlugStable(a, b)).toBe(true);
  });

  // ── Existing Jaccard / containment guarantees still hold ────────────────
  it('keeps Jaccard-stable behavior for minor title wording changes (no location)', () => {
    // Real-world example referenced in CLAUDE.md: USI/SUPSI title wording shifts.
    const before = 'borsista-di-ricerca-per-la-bibliometria-presso-laboratorio-usi';
    const after = 'borsista-di-ricerca-bibliometria-presso-laboratorio-usi';
    expect(isSlugStable(before, after)).toBe(true);
  });

  it('keeps containment-based stability when new slug is an extension of the existing one', () => {
    // Existing crawler-common behavior: shorter slug fully contained in longer one.
    const shortSlug = 'borsista-di-ricerca-bibliometria-laboratorio';
    const longSlug = 'borsista-di-ricerca-bibliometria-laboratorio-usi-lugano';
    expect(isSlugStable(shortSlug, longSlug)).toBe(true);
  });

  it('returns false for genuinely different roles regardless of location', () => {
    const a = 'apprendista-cuoco-cfp-lidl-svizzera-cadenazzo';
    const b = 'responsabile-filiale-lidl-svizzera-cadenazzo';
    expect(isSlugStable(a, b)).toBe(false);
  });

  // ── Identity / edge cases ────────────────────────────────────────────────
  it('returns false when existing slug is empty', () => {
    expect(isSlugStable('', 'apprendistato-cadenazzo')).toBe(false);
  });

  it('treats an empty newLocation as missing (does not block stability)', () => {
    // If the caller can only resolve one side's location, fall back to the
    // legacy Jaccard check rather than misclassifying the slug as unstable.
    const slug = 'apprendistato-nel-commercio-al-dettaglio-cfp-o-afc-inizio-2026-lidl-svizzera-cadenazzo';
    expect(
      isSlugStable(slug, slug, { existingLocation: 'Cadenazzo', newLocation: '' }),
    ).toBe(true);
  });
});
