import { describe, expect, it } from 'vitest';
import { rotateForScan } from '../scripts/ci/followup-drainer.mjs';

const CAP = 5;

describe('parent-close — copertura stabile su un pool mutabile', () => {
  it('non perde la coorte iniziale quando entrano padri nuovi e cambia l’ordine', () => {
    const initial = Array.from({ length: 39 }, (_, index) => ({ id: index + 1 }));
    let current = [...initial];
    let cursor: string | null = null;
    const seenInitial = new Set<number>();

    for (let scan = 0; scan < 8; scan += 1) {
      if (scan > 0) {
        current = [
          { id: 100 + scan },
          ...current.slice().reverse(),
        ];
      }
      const ordered = rotateForScan(current, {
        scanMax: CAP,
        cursor,
        getKey: (parent) => parent.id,
      });
      const examined = ordered.slice(0, CAP);
      for (const parent of examined) {
        if (parent.id <= 39) seenInitial.add(parent.id);
      }
      cursor = String(examined.at(-1)?.id ?? cursor);
    }

    expect(seenInitial.size).toBe(initial.length);
  });

  it('riprende dopo la rimozione del cursore dal pool', () => {
    const current = [{ id: 1 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const ordered = rotateForScan(current, {
      scanMax: CAP,
      cursor: '2',
      getKey: (parent) => parent.id,
    });

    expect(ordered.map((parent) => parent.id)).toEqual([3, 4, 5, 1]);
  });
});
