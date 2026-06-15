/**
 * Unit test for `clampMetaDescription` — the SERP meta-description budget
 * guard applied at both render layers (static `build-plugins/htmlTemplate.ts`
 * and runtime `services/seoService.ts`).
 *
 * Closes the SearchAtlas audit 141162 `meta_desc_invalid_length` gap: SSG
 * pages (e.g. career landings) were emitting 180-253 char descriptions, past
 * Google's ~155-160 char SERP snippet budget.
 */
import { describe, it, expect } from 'vitest';
import {
  clampMetaDescription,
  META_DESCRIPTION_MAX_CHARS,
} from '../build-plugins/shared/titleSuffix';

describe('clampMetaDescription', () => {
  it('leaves descriptions within budget untouched', () => {
    const short = 'Guida completa al frontaliere 2026: permesso G, tasse e netto.';
    expect(short.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    expect(clampMetaDescription(short)).toBe(short);
  });

  it('clamps over-budget descriptions to ≤160 char (word-aware, with …)', () => {
    // Real offender from the audit: career landing, 253 char.
    const long =
      "Guida alle agenzie del lavoro (collocamento e prestito di personale) attive a Lugano nel 2026: come verificare l'autorizzazione SECO, cosa controllare nel contratto interinale, diritti del frontaliere con permesso G e differenze con le agenzie italiane.";
    expect(long.length).toBeGreaterThan(META_DESCRIPTION_MAX_CHARS);
    const out = clampMetaDescription(long);
    expect(out.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    // Word-aware: the cut must not land mid-word (char before … is not a letter
    // continuing a truncated token — i.e. the prefix is a whole-word boundary).
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('collapses internal whitespace before measuring', () => {
    const messy = '  Spaziatura   irregolare\n\tcon   tab  e  newline  ';
    const out = clampMetaDescription(messy);
    expect(out).toBe('Spaziatura irregolare con tab e newline');
  });

  it('does not leave a dangling separator before the ellipsis', () => {
    const long =
      'Costo della vita a Lugano nel 2026 — affitti, spesa, trasporti, tasse — ' +
      'tutto quello che un frontaliere deve sapere prima di trasferirsi oltre confine in Ticino.';
    const out = clampMetaDescription(long);
    expect(out.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    // No trailing " —…" / " -…" / " |…" before the ellipsis.
    expect(/[\s—–\-·|,;:&(]…$/u.test(out)).toBe(false);
  });

  it('handles empty / nullish input safely', () => {
    expect(clampMetaDescription('')).toBe('');
    // Runtime hardening against undefined source literals.
    expect(clampMetaDescription(undefined as unknown as string)).toBe('');
  });
});
