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

  it('picks a candidate landing at the exact boundary (66 chars) verbatim', () => {
    // Constructed so the full candidate is exactly TITLE_MAX_CHARS (66) —
    // verifies the `<=` fit check treats the boundary as fitting, matching
    // the pre-PR unconditional-emit behavior for names at the cap.
    const comune = 'Bellinzona-e-Bassa-Riviera';
    const full = `Eventi a ${comune}: cosa fare e agenda aggiornata`;
    expect(full.length).toBe(TITLE_MAX_CHARS);
    const out = composePlaceTitle([
      full,
      `Eventi a ${comune}: agenda aggiornata`,
      `Eventi a ${comune}`,
    ]);
    expect(out).toBe(full);
  });

  it('last-resort truncates a real multi-hyphen place name at a clean boundary (no dangling separator)', () => {
    // Real word fragments (comune/frazione names), not a repeated-char
    // stress fixture — exercises truncateHeadline's word/separator-boundary
    // logic against a name shape event-sourcing can plausibly emit after
    // comune-merger concatenation, rather than only an 80x'A' edge case.
    const comune = 'Bellinzona-Giubiasco-Sant-Antonio-Daro-Carasso-Sementina-Nord';
    const out = composePlaceTitle([
      `Eventi a ${comune}: cosa fare e agenda aggiornata`,
      `Eventi a ${comune}: agenda aggiornata`,
      `Eventi a ${comune}`,
    ]);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // No dangling separator (hyphen/dash/pipe/etc.) directly before the
    // ellipsis — truncateHeadline strips these before appending "…".
    expect(out).not.toMatch(/[\s—–\-·|,;:&(]…$/u);
  });

  it('accepts a measureLength override so escaped length gates the fit check (avoids post-escape overflow)', () => {
    // eventsSeoPagesPlugin/locationHubBridgePlugin/companyHubBridgePlugin all
    // render the chosen candidate through a single-escape shell (esc(title)
    // in htmlTemplate.ts). A candidate with raw & fits pre-escape but expands
    // (&amp;) past the cap post-escape — this is the actual shape of
    // crawler-derived company names (e.g. "Rossi & Figli & Nipoti & Co"),
    // the sibling-fix target in companyHubBridgePlugin.ts's matchedTitle.
    const esc = (s: string) => s.replace(/&/g, '&amp;');
    const company = 'Rossi & Figli & Nipoti & Co';
    const candidates = [
      `Offerte di lavoro ${company} — 12 annunci attivi`,
      `Offerte di lavoro ${company} — 12 annunci`,
      `Offerte di lavoro ${company}`,
    ];
    // Raw length alone would (wrongly) accept the first candidate — its
    // escaped form overflows the cap.
    expect(candidates[0].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(esc(candidates[0]).length).toBeGreaterThan(TITLE_MAX_CHARS);

    const outRaw = composePlaceTitle(candidates);
    expect(outRaw).toBe(candidates[0]);

    const outEscAware = composePlaceTitle(candidates, TITLE_MAX_CHARS, (s) => esc(s).length);
    expect(outEscAware).toBe(candidates[2]);
    expect(esc(outEscAware).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});
