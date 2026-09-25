/**
 * pr-collision-detector: le draft NON partecipano al grafo delle collisioni.
 *
 * Era l'unico componente del ciclo a non saltare le draft (auto-merge-eval,
 * auto-merge-sweep, pr-autorebase, stale-pr-rescuer e pr-review-loop lo fanno
 * tutti). Conseguenza osservata su nanakokyobashi-rgb/frontaliere-articles#33:
 * una draft di sola conservazione, aperta per NON essere mergiata, toccava 22
 * file `.github/workflows/**` e 7 `scripts/lib/**` e avrebbe etichettato
 * `collision-risk` ogni futura PR su quei path — contro una controparte che non
 * poteva mergiare mai.
 */
import { describe, it, expect } from 'vitest';
import { selectCollisionCandidates, computeColliders } from '../scripts/ci/pr-collision-detector.mjs';

describe('selectCollisionCandidates', () => {
  it('tiene le open non-draft, scarta le draft', () => {
    expect(selectCollisionCandidates([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false },
    ])).toEqual([1, 3]);
  });

  it('isDraft assente → partecipa (degrada al comportamento storico, non a uno scan muto)', () => {
    expect(selectCollisionCandidates([{ number: 7 }])).toEqual([7]);
  });

  it('scarta entry senza numero intero valido', () => {
    const prs = [
      { number: 10, isDraft: false },
      { isDraft: false },
      { number: 'x', isDraft: false },
      null,
    ] as unknown as { number: number; isDraft: boolean }[];
    expect(selectCollisionCandidates(prs)).toEqual([10]);
  });

  it('input non-array o vuoto → []', () => {
    expect(selectCollisionCandidates(undefined as unknown as [])).toEqual([]);
    expect(selectCollisionCandidates([])).toEqual([]);
  });
});

describe('computeColliders', () => {
  const WF = '.github/workflows/tests.yml';

  it('due PR che condividono un file funnel-critical collidono, in entrambi i versi', () => {
    const files = new Map([
      [1, new Set([WF])],
      [2, new Set([WF])],
    ]);
    const c = computeColliders([1, 2], files);
    expect(c.get(1)?.get(2)).toEqual([WF]);
    expect(c.get(2)?.get(1)).toEqual([WF]);
  });

  it('una draft (set vuoto) non collide con nessuno, per quanti file condivida davvero', () => {
    // #33 = la draft di conservazione: il chiamante le assegna un set VUOTO
    // invece dei suoi 29 file funnel-critical, ed è così che esce dal grafo.
    const files = new Map([
      [33, new Set<string>()],
      [34, new Set([WF])],
      [35, new Set([WF])],
    ]);
    const c = computeColliders([33, 34, 35], files);
    expect(c.has(33)).toBe(false);
    // le due PR reali continuano a collidere fra loro: il filtro non spegne lo scan.
    expect(c.get(34)?.get(35)).toEqual([WF]);
  });

  it('PR assente dalla mappa → nessuna collisione, nessun throw', () => {
    const c = computeColliders([1, 2], new Map([[1, new Set([WF])]]));
    expect(c.size).toBe(0);
  });

  it('nessun file condiviso → grafo vuoto', () => {
    const files = new Map([
      [1, new Set(['scripts/lib/a.mjs'])],
      [2, new Set(['scripts/lib/b.mjs'])],
    ]);
    expect(computeColliders([1, 2], files).size).toBe(0);
  });
});
