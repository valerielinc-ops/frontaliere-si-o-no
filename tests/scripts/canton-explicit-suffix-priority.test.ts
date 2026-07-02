/**
 * inferAnyCanton() / inferSwissTargetCanton() — explicit canton-code suffix
 * must win over a same-string fuzzy city-name match for a DIFFERENT canton.
 *
 * Root cause: TARGET_CANTONS lists AG before BE. "Brügg BE" normalizes
 * (accent-stripped, lower-cased) the same as "Brugg" — a real town in
 * canton Aargau — so the old single-pass loop matched AG's BFS city-token
 * list before ever reaching BE's own signal, silently mis-routing a Bern
 * job to Aargau. Swiss job postings routinely end addresses with the
 * canton code ("Bern BE", "Brügg BE", "Wallisellen ZH"); that trailing
 * token is an explicit, author-stated signal and must be checked for every
 * candidate canton before any canton's fuzzy city match is allowed to win.
 */
import { describe, it, expect } from 'vitest';
import { inferAnyCanton, inferSwissTargetCanton } from '../../scripts/lib/target-swiss-locations.mjs';

describe('explicit canton-code suffix beats cross-canton fuzzy city match', () => {
  it('resolves "Brügg BE" to BE, not AG (Brugg AG collision)', () => {
    expect(inferAnyCanton('Brügg BE')).toBe('BE');
    expect(inferSwissTargetCanton('Brügg BE')).toBe('BE');
  });

  it('still resolves plain "Brugg" (no suffix) via the AG fuzzy city match', () => {
    expect(inferAnyCanton('Brugg')).toBe('AG');
  });

  it('resolves other trailing-suffix addresses correctly', () => {
    expect(inferAnyCanton('Bern BE')).toBe('BE');
    expect(inferAnyCanton('Wallisellen ZH')).toBe('ZH');
    expect(inferAnyCanton('Lugano TI')).toBe('TI');
  });

  it('does not let an unrelated trailing token be mistaken for a canton code', () => {
    expect(inferAnyCanton('Sales Manager')).toBe('');
  });
});
