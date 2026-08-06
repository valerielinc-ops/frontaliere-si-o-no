/**
 * The livability ranking discloses its rent axis in the DEFAULT view
 * (issue #4545 residual 4, follow-up to the disclosure shipped in
 * `services/avgRentEstimate.ts`).
 *
 * What was wrong. `avgRentMonthly` is a zone-level estimate — 32 distinct
 * values across 518 comuni, 483 of which repeat a neighbour's figure — and
 * `LivabilityIndex` folds it into the composite score at `W_RENT` (25 %). The
 * axis note, however, rendered only while `sortBy === 'rent'`. That conditional
 * was copied from `BorderMunicipalitiesMap`, where it is right: that surface
 * colours BY rent only in `colorMode === 'rent'`, so outside that mode the
 * estimate drives nothing visible. In the ranking the axis is never inactive —
 * it weighs on every row in every sort mode — so the conditional hid the
 * disclosure in precisely the view the page exists for, the score ranking that
 * loads by default.
 *
 * That it decides the ordering rather than breaking ties is measurable on the
 * committed dataset, and is asserted below rather than asserted in prose:
 * removing the rent axis moves 513 of 518 ranks.
 *
 * Why rendering rather than reading the source. A source-text assertion
 * ("the file mentions rentScoreShareNote") passes for a call site that is still
 * behind a conditional — the exact bug. Mounting the component in its default
 * state and looking for the text is the only form that fails on the unfixed
 * code, which is the property that makes this test worth having.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { MUNICIPALITIES } from '@/data/municipalities';
import { rentScoreShareNote } from '@/services/avgRentEstimate';

// `t` returns the key: the disclosure under test does NOT come from i18n (it
// lives in services/avgRentEstimate.ts, so the SSG side can share it), so a
// key-echoing `t` cannot accidentally satisfy the assertions below.
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' as const }),
  getCantonI18nParams: () => ({}) as Record<string, string>,
}));

// The Leaflet map is lazy and irrelevant here (table is the default view).
vi.mock('@/components/vita/LivabilityMap', () => ({ default: () => null }));

import LivabilityIndex from '@/components/vita/LivabilityIndex';

/** Mirrors the W_RENT constant in the component under test. */
const W_RENT_PERCENT = 25;

afterEach(cleanup);

describe('the rent axis really drives the ranking, not just ties', () => {
  // If this ever stops holding, the disclosure could be relaxed — so the
  // justification for the note is kept executable instead of only in prose.
  it('decides most of the ordering: removing it moves nearly every rank', () => {
    const W = { dist: 0.3, rent: 0.25, irpef: 0.2, pop: 0.15, fascia: 0.1 };
    const norm = (v: number, lo: number, hi: number) => (hi === lo ? 1 : (v - lo) / (hi - lo));

    const levies = MUNICIPALITIES.filter((m) => m.irpefAddizionale > 0).map((m) => m.irpefAddizionale);
    const [loIrpef, hiIrpef] = [Math.min(...levies), Math.max(...levies)];
    const bounds = (sel: (m: (typeof MUNICIPALITIES)[number]) => number) => {
      const vs = MUNICIPALITIES.map(sel);
      return [Math.min(...vs), Math.max(...vs)] as const;
    };
    const [loD, hiD] = bounds((m) => m.distanceKm);
    const [loR, hiR] = bounds((m) => m.avgRentMonthly);
    const [loP, hiP] = bounds((m) => m.population);

    const rankNames = (withRent: boolean) =>
      MUNICIPALITIES.map((m) => {
        const irpef = m.irpefAddizionale > 0 ? 1 - norm(m.irpefAddizionale, loIrpef, hiIrpef) : null;
        const wRent = withRent ? W.rent : 0;
        const applicable = W.dist + wRent + W.pop + W.fascia + (irpef === null ? 0 : W.irpef);
        const weighted =
          (1 - norm(m.distanceKm, loD, hiD)) * W.dist +
          (withRent ? (1 - norm(m.avgRentMonthly, loR, hiR)) * W.rent : 0) +
          (irpef === null ? 0 : irpef * W.irpef) +
          norm(m.population, loP, hiP) * W.pop +
          (m.fascia === '1' ? 1 : m.fascia === '1A' ? 0.6 : 0.2) * W.fascia;
        return { name: m.name, score: Math.round((weighted / applicable) * 100) / 100 };
      })
        .sort((a, b) => b.score - a.score)
        .map((m) => m.name);

    const withRent = rankNames(true);
    const posWithout = new Map(rankNames(false).map((n, i) => [n, i]));
    const moved = withRent.filter((n, i) => posWithout.get(n) !== i).length;

    // Measured 513/518 on the committed dataset.
    expect(moved / MUNICIPALITIES.length).toBeGreaterThan(0.9);
  });

  it('offers far fewer real steps than the ranking implies', () => {
    const distinct = new Set(MUNICIPALITIES.map((m) => m.avgRentMonthly));
    expect(MUNICIPALITIES.length).toBeGreaterThan(500);
    expect(distinct.size).toBeLessThan(50);
  });
});

describe('LivabilityIndex discloses the rent estimate without any interaction', () => {
  const expected = rentScoreShareNote(W_RENT_PERCENT, 'it');

  it('shows the note on first render, sorted by score (the default view)', () => {
    render(<LivabilityIndex />);
    // Default sort is 'score' — assert that, so the test cannot pass because
    // some other default happened to select the rent sort.
    expect((screen.getByLabelText('livability.sortBy') as HTMLSelectElement).value).toBe('score');
    expect(screen.getByTestId('livability-rent-score-share')).toHaveTextContent(expected);
  });

  it('names the weight the legend claims, so the two cannot drift apart', () => {
    render(<LivabilityIndex />);
    expect(screen.getByTestId('livability-rent-score-share').textContent).toContain(
      `${W_RENT_PERCENT}%`,
    );
  });

  it('keeps the note under every sort mode, since the axis is always weighted', () => {
    render(<LivabilityIndex />);
    const sort = screen.getByLabelText('livability.sortBy');
    for (const mode of ['distance', 'irpef', 'population', 'score']) {
      fireEvent.change(sort, { target: { value: mode } });
      expect(
        screen.getByTestId('livability-rent-score-share'),
        `disclosure disappeared while sorting by ${mode}`,
      ).toHaveTextContent(expected);
    }
  });

  it('states that the figure is an estimate, not a measured per-comune value', () => {
    render(<LivabilityIndex />);
    const text = screen.getByTestId('livability-rent-score-share').textContent ?? '';
    // A note trimmed down to "indicative" would not tell the reader the
    // ranking inherits the approximation — that is the part that matters.
    expect(text.toLowerCase()).toContain('stima');
    expect(text).toContain('518');
  });
});

describe('the note is localized', () => {
  it('differs per locale (no untranslated fallback)', () => {
    const notes = new Set(['it', 'en', 'de', 'fr'].map((l) => rentScoreShareNote(W_RENT_PERCENT, l)));
    expect(notes.size).toBe(4);
  });

  it('carries the weight through in every locale', () => {
    for (const l of ['it', 'en', 'de', 'fr']) {
      expect(rentScoreShareNote(W_RENT_PERCENT, l)).toContain('25%');
    }
    // Parameterised, not hardcoded: a different weight must change the copy.
    expect(rentScoreShareNote(40, 'it')).toContain('40%');
  });

  it('falls back to Italian for an unknown locale rather than throwing', () => {
    expect(rentScoreShareNote(W_RENT_PERCENT, 'xx')).toBe(rentScoreShareNote(W_RENT_PERCENT, 'it'));
  });
});
