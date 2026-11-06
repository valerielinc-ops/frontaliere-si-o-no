/**
 * #900/#901 — safeLocationToken guards a parser-derived location before it
 * flows into a slug or addressLocality, so the literal string "undefined"/"null"
 * (truthy → slips past `|| fallback`) can never leak `-undefined` into active
 * slugs (sitemap-canonical gate) or `addressLocality: "undefined"` into JSON-LD
 * (Google de-index; AGENTS.md non-negotiable #3).
 */

import { describe, it, expect } from 'vitest';
import { safeLocationToken } from '../scripts/lib/safe-location-token.mjs';

describe('safeLocationToken (#900/#901)', () => {
  it('passes a valid location through unchanged', () => {
    expect(safeLocationToken('Lugano')).toBe('Lugano');
  });

  it('returns default fallback for the literal "undefined"/"null" string (case-insensitive)', () => {
    expect(safeLocationToken('undefined')).toBe('Ticino');
    expect(safeLocationToken('UNDEFINED')).toBe('Ticino');
    expect(safeLocationToken('null')).toBe('Ticino');
    expect(safeLocationToken('Null')).toBe('Ticino');
  });

  it('returns default fallback for JS undefined/null/empty/whitespace', () => {
    expect(safeLocationToken(undefined)).toBe('Ticino');
    expect(safeLocationToken(null)).toBe('Ticino');
    expect(safeLocationToken('')).toBe('Ticino');
    expect(safeLocationToken('   ')).toBe('Ticino');
  });

  it('honors a custom fallback', () => {
    expect(safeLocationToken('undefined', 'Landquart')).toBe('Landquart');
    expect(safeLocationToken(undefined, 'Ticino')).toBe('Ticino');
  });

  it('trims surrounding whitespace on valid values', () => {
    expect(safeLocationToken('  Bellinzona  ')).toBe('Bellinzona');
  });
});
