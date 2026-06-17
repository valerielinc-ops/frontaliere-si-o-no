/**
 * selectSweepCandidates — quali PR il sweep periodico ri-valuta: tutte le OPEN
 * non-draft. Il gating fine (LGTM/vitest/collision) è delegato ad auto-merge-eval
 * (DRY), quindi il filtro qui è solo "non-draft + numero valido".
 */
import { describe, it, expect } from 'vitest';
import { selectSweepCandidates } from '../scripts/ci/auto-merge-sweep.mjs';

describe('selectSweepCandidates (auto-merge periodic sweep)', () => {
  it('tiene le PR open non-draft, scarta i draft', () => {
    const prs = [
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false },
    ];
    expect(selectSweepCandidates(prs)).toEqual([1, 3]);
  });

  it('scarta entry senza numero intero valido', () => {
    const prs = [
      { number: 10, isDraft: false },
      { isDraft: false },
      { number: 'x', isDraft: false },
      null,
    ] as unknown as { number: number; isDraft: boolean }[];
    expect(selectSweepCandidates(prs)).toEqual([10]);
  });

  it('input non-array o vuoto → []', () => {
    expect(selectSweepCandidates(undefined as unknown as [])).toEqual([]);
    expect(selectSweepCandidates([])).toEqual([]);
  });

  it('tutti draft → [] (niente da ri-valutare)', () => {
    expect(selectSweepCandidates([{ number: 1, isDraft: true }, { number: 2, isDraft: true }])).toEqual([]);
  });
});
