/**
 * issue #4570 (sibling occurrence) — `runBfsStrict()` used the loose
 * `isKnownSwissMunicipality` check, which folds bare canton name/code
 * aliases ("Ticino", "TI", "Graubünden"...) into its match set. A job whose
 * `addressLocality` was just a canton-only label therefore returned
 * `{ canton, confidence: 'high' }` from BFS-strict alone — the same forged-
 * canton-only-label class of bug fixed elsewhere in this codebase for
 * `assemble-jobs-dataset.mjs`'s fill/override step, but reproduced here in
 * `applyCantonQuorumGate`, which feeds SEO per-canton routing
 * (`build-plugins/jobsSeoPagesPlugin.ts`) directly off `cantonConfidence`.
 *
 * `runBfsStrict` now uses the strict `isKnownSwissCity` check instead, which
 * excludes canton-only labels — see `scripts/lib/canton-quorum-gate.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { runBfsStrict, applyCantonQuorumGate, run2of3Quorum } from '../scripts/lib/canton-quorum-gate.mjs';

describe('runBfsStrict (#4570 sibling)', () => {
  it('does not classify a bare canton name label as high confidence', () => {
    expect(runBfsStrict({ addressLocality: 'Ticino' })).toEqual({ canton: '', confidence: 'low' });
    expect(runBfsStrict({ addressLocality: 'Graubünden' })).toEqual({ canton: '', confidence: 'low' });
  });

  it('still classifies a real municipality as high confidence', () => {
    expect(runBfsStrict({ addressLocality: 'Lugano' })).toEqual({ canton: 'TI', confidence: 'high' });
  });
});

describe('run2of3Quorum (#4570 sibling, round 2 — quorum on bare canton-name repetition)', () => {
  it('does not reach high confidence when 2/3 fields only repeat the bare canton name, no real city anywhere', () => {
    // title + addressLocality both just say "Ticino" — no city-level evidence
    // in any of the 3 fields. Same weak signal runBfsStrict already rejects,
    // doubled across fields instead of appearing once.
    expect(
      run2of3Quorum({
        title: 'Stelle in Ticino',
        body: 'Wir suchen eine motivierte Person.',
        addressLocality: 'Ticino',
      })
    ).toEqual({ canton: '', confidence: 'low' });
  });

  it('still reaches high confidence when 2/3 fields agree AND a real city corroborates the canton', () => {
    expect(
      run2of3Quorum({
        title: 'Stelle in Ticino',
        body: 'Arbeitsort: Lugano.',
        addressLocality: 'Ticino',
      })
    ).toEqual({ canton: 'TI', confidence: 'high' });
  });

  it('does not corroborate from a field that did not vote for the winning canton (#4617 item 2)', () => {
    // title + addressLocality both vote TI via the bare canton name (no real
    // city in either) -- the body votes ZH (Zürich named first) but happens
    // to mention Lugano in unrelated boilerplate. A real city named in a
    // non-voting field must not corroborate a vote it didn't cast.
    expect(
      run2of3Quorum({
        title: 'Filiale Ticino',
        body: 'Filiali in tutta la Svizzera: Zürich, Lugano, Ginevra.',
        addressLocality: 'Ticino',
      })
    ).toEqual({ canton: '', confidence: 'low' });
  });
});

describe('applyCantonQuorumGate (#4570 sibling)', () => {
  it('does not let a bare canton-only addressLocality override the existing canton via BFS-strict/quorum', () => {
    const job = {
      title: 'Sachbearbeiter Rechnungswesen',
      description: 'Wir suchen einen Sachbearbeiter.',
      addressLocality: 'Ticino',
      addressCountry: 'CH',
      canton: 'SO',
    };
    const result = applyCantonQuorumGate(job);
    expect(result.confidence).toBe('low');
    expect(result.canton).toBe('SO');
  });
});
