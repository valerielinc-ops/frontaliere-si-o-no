import { describe, expect, it } from 'vitest';
import {
  parentCloseCursorFromComments,
  parentCloseCursorMarkerBody,
  rotateForScan,
} from '../scripts/ci/followup-drainer.mjs';

const CAP = 5;
const BUDGET = 2;

const pool = Array.from({ length: 39 }, (_, index) => ({ number: index + 1 }));

describe('parent-close — il cursore avanza per le issue davvero esaminate', () => {
  it('riprende dopo il budget parziale senza saltare la coda residua', () => {
    let cursor: string | null = null;
    const seen = new Set<number>();

    for (let scan = 0; scan < Math.ceil(pool.length / BUDGET); scan += 1) {
      const ordered = rotateForScan(pool, {
        scanMax: CAP,
        cursor,
        getKey: (parent) => parent.number,
      });
      const examined = ordered.slice(0, BUDGET);
      for (const parent of examined) seen.add(parent.number);
      cursor = String(examined.at(-1)?.number ?? cursor);
    }

    expect(seen.size).toBe(pool.length);
  });

  it('il secondo run parte da 3 quando il primo ne ha esaminate solo 2', () => {
    const first = rotateForScan(pool, {
      scanMax: CAP,
      cursor: null,
      getKey: (parent) => parent.number,
    }).slice(0, BUDGET);
    const second = rotateForScan(pool, {
      scanMax: CAP,
      cursor: String(first.at(-1)?.number),
      getKey: (parent) => parent.number,
    }).slice(0, BUDGET);

    expect(first.map((parent) => parent.number)).toEqual([1, 2]);
    expect(second.map((parent) => parent.number)).toEqual([3, 4]);
  });
});

describe('parent-close — marker durevole', () => {
  it('legge l’ultimo marker e conserva l’id REST del commento da aggiornare', () => {
    const comments = [
      { body: parentCloseCursorMarkerBody(2), url: 'https://github.com/x/y/issues/1#issuecomment-10' },
      { body: 'commento umano' },
      { body: parentCloseCursorMarkerBody(4), id: 20, url: 'https://api.github.com/repos/x/y/issues/comments/20' },
    ];

    expect(parentCloseCursorFromComments(comments)).toEqual({ cursor: '4', commentId: '20' });
    expect(parentCloseCursorFromComments(null)).toBeNull();
  });
});
