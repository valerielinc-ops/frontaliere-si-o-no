/**
 * Regression for the `labor` keyword branch of `detectHealthcareCategory`.
 * Plain `/labor/` (no word boundary) matched inside common Italian/French
 * words that have nothing to do with lab work — "collaboratore"/"collaborateur"
 * (co-worker) and "elaborare"/"elaborazione" (to process/processing) all
 * contain the substring "labor" — mis-tagging generic admin/office jobs as
 * "Sanità / Ospedali". Fixed by requiring a word boundary (`\blabor`).
 *
 * Known accepted trade-off: `\blabor` also stops matching unspaced German
 * compounds like "Chemielaborant" (no boundary between "chemie" and "labor").
 * Not fixed here — every current caller either has no fallback override or
 * defaults to 'Sanità / Ospedali' already, so the compound-word miss falls
 * through to the same category via the function's default fallback anyway.
 */
import { describe, expect, it } from 'vitest';
import { detectHealthcareCategory } from '@/scripts/lib/hospital-custom-html-helpers.mjs';

describe('detectHealthcareCategory — labor keyword boundary', () => {
  it('does not mis-tag "collaboratore" (Italian: co-worker/collaborator) as healthcare via the labor branch', () => {
    expect(detectHealthcareCategory('Collaboratore amministrativo 80-100%', 'Amministrazione')).toBe(
      'Amministrazione',
    );
  });

  it('does not mis-tag "collaborateur" (French: co-worker) as healthcare via the labor branch', () => {
    expect(detectHealthcareCategory('Collaborateur/-trice logistique', 'Logistica')).toBe('Logistica');
  });

  it('does not mis-tag "elaborazione dati" (Italian: data processing) as healthcare via the labor branch', () => {
    expect(detectHealthcareCategory('Addetto elaborazione dati e reportistica', 'Amministrazione')).toBe(
      'Amministrazione',
    );
  });

  it('still matches genuine lab-technician titles ("Laborant")', () => {
    expect(detectHealthcareCategory('Laborant EFZ 100%', 'Amministrazione')).toBe('Sanità / Ospedali');
  });

  it('still matches "Laboratorio"/"Laboratoire" (lab, space/hyphen separated)', () => {
    expect(detectHealthcareCategory('Tecnico di laboratorio', 'Amministrazione')).toBe('Sanità / Ospedali');
    expect(detectHealthcareCategory('Technicien de laboratoire médical', 'Amministrazione')).toBe(
      'Sanità / Ospedali',
    );
  });

  it('accepted trade-off: unspaced German compound "Chemielaborant" no longer matches the labor branch, but falls through to the same default fallback for genuine hospital parsers', () => {
    // Default fallback is already 'Sanità / Ospedali' — no regression for hospital/clinic parsers.
    expect(detectHealthcareCategory('Chemielaborant 100%')).toBe('Sanità / Ospedali');
  });
});
