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
import { runBfsStrict, applyCantonQuorumGate } from '../scripts/lib/canton-quorum-gate.mjs';

describe('runBfsStrict (#4570 sibling)', () => {
  it('does not classify a bare canton name label as high confidence', () => {
    expect(runBfsStrict({ addressLocality: 'Ticino' })).toEqual({ canton: '', confidence: 'low' });
    expect(runBfsStrict({ addressLocality: 'Graubünden' })).toEqual({ canton: '', confidence: 'low' });
  });

  it('still classifies a real municipality as high confidence', () => {
    expect(runBfsStrict({ addressLocality: 'Lugano' })).toEqual({ canton: 'TI', confidence: 'high' });
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
