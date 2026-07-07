/**
 * Unit tests for `composePlaceTitle` in `build-plugins/shared/titleSuffix.ts`.
 *
 * Regression coverage for #3772: `eventsSeoPagesPlugin.ts` comune titles used
 * unbounded template-literal concatenation with no length budget, so the
 * nationwide event-sourcing expansion (longer FR/DE municipality names beyond
 * the short-named Ticino set the copy was tuned for) pushed hundreds of
 * `<title>` tags over TITLE_MAX_CHARS and tripped the audit:title-length rate
 * ratchet for the "eventi" feature. `composePlaceTitle` cascades through
 * shorter candidates before ever truncating the place name itself, mirroring
 * `composeSerpJobTitle`'s "never drop the city" policy. This test locks the
 * cascade behavior at the unit level so a future regression fails fast in
 * `npm test`, not only in the nightly SSG audit.
 */
import { describe, it, expect } from 'vitest';
import { composePlaceTitle, TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';

describe('composePlaceTitle', () => {
  it('returns the first (most descriptive) candidate verbatim when it fits', () => {
    const out = composePlaceTitle([
      'Eventi a Lugano: cosa fare e agenda aggiornata',
      'Eventi a Lugano: agenda aggiornata',
      'Eventi a Lugano',
    ]);
    expect(out).toBe('Eventi a Lugano: cosa fare e agenda aggiornata');
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('falls to a shorter candidate when the longest overflows, preserving the place name in full', () => {
    // A long real-world French municipality name that overflows the
    // most-descriptive candidate but fits the shorter ones.
    const comune = 'Saint-Sulpice-sur-Risle-les-Bains';
    const candidates = [
      `Eventi a ${comune}: cosa fare e agenda aggiornata`,
      `Eventi a ${comune}: agenda aggiornata`,
      `Eventi a ${comune}`,
    ];
    expect(candidates[0].length).toBeGreaterThan(TITLE_MAX_CHARS);
    const out = composePlaceTitle(candidates);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // The place name itself is never truncated by the cascade.
    expect(out).toContain(comune);
  });

  it('last-resort truncates the shortest candidate if even it overflows, and still respects the cap', () => {
    const implausiblyLongName = 'A'.repeat(80);
    const out = composePlaceTitle([
      `Eventi a ${implausiblyLongName}: cosa fare e agenda aggiornata`,
      `Eventi a ${implausiblyLongName}: agenda aggiornata`,
      `Eventi a ${implausiblyLongName}`,
    ]);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('respects a custom maxChars override', () => {
    const out = composePlaceTitle(['Eventi a Lugano: agenda aggiornata', 'Eventi a Lugano'], 20);
    expect(out).toBe('Eventi a Lugano');
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
