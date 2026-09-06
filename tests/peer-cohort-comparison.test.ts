/**
 * The observer for issue #7386.
 *
 * The four families under the Information Gain floor share one defect: after
 * mask no. 1 of `scripts/lib/informationGain.mjs` turns every figure into `#`,
 * no segment on the page belongs to the page. The block these tests cover is
 * the fix, so what has to be pinned is not "does it render" but the two
 * properties that make it work: the emitted prose must DIFFER between two
 * sibling pages of the same cohort, and it must be stable across builds.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPeerProse,
  peerWindow,
  rankPeerRows,
  renderPeerComparison,
  type PeerRow,
} from '../build-plugins/shared/peerCohortComparison';

const rows: PeerRow[] = [
  { key: 'a', name: 'Alfa', href: '/alfa/', value: 10 },
  { key: 'b', name: 'Bravo', href: '/bravo/', value: 20 },
  { key: 'c', name: 'Charlie', href: '/charlie/', value: 30 },
  { key: 'd', name: 'Delta', href: '/delta/', value: 40 },
  { key: 'e', name: 'Echo', href: '/echo/', value: 50 },
  { key: 'f', name: 'Foxtrot', href: '/foxtrot/', value: null },
];

const labels = { heading: 'Confronto', metricLabel: 'offerte attive', peerNoun: 'cantoni' };
const fmt = (value: number) => String(value);

describe('rankPeerRows', () => {
  it('drops rows without a figure and ranks from the largest when higherIsBetter', () => {
    const ranked = rankPeerRows(rows, true);
    expect(ranked.map((r) => r.key)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(ranked[0].rank).toBe(1);
  });

  it('ranks from the smallest when higherIsBetter is false', () => {
    expect(rankPeerRows(rows, false).map((r) => r.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('gives tied rows the same rank instead of an array position', () => {
    const tied: PeerRow[] = [
      { key: 'x', name: 'X', value: 5 },
      { key: 'y', name: 'Y', value: 5 },
      { key: 'z', name: 'Z', value: 9 },
    ];
    const ranked = rankPeerRows(tied, true);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2]);
  });

  it('breaks ties on key, so the emitted order cannot depend on input order', () => {
    const forward: PeerRow[] = [
      { key: 'y', name: 'Y', value: 5 },
      { key: 'x', name: 'X', value: 5 },
    ];
    const backward = [...forward].reverse();
    expect(rankPeerRows(forward, true).map((r) => r.key)).toEqual(
      rankPeerRows(backward, true).map((r) => r.key),
    );
  });
});

describe('peerWindow', () => {
  it('keeps the current row, its neighbours and both extremes, in ranking order', () => {
    const ranked = rankPeerRows(rows, true);
    expect(peerWindow(ranked, 'c', 1).map((r) => r.key)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(peerWindow(ranked, 'e', 1).map((r) => r.key)).toEqual(['e', 'd', 'a']);
  });

  it('is empty for a key outside its own cohort', () => {
    expect(peerWindow(rankPeerRows(rows, true), 'zzz', 2)).toEqual([]);
  });
});

describe('buildPeerProse', () => {
  it('names the neighbours, which is what differs between sibling pages', () => {
    const ranked = rankPeerRows(rows, true);
    const middle = buildPeerProse({ locale: 'it', ranked, currentKey: 'c', labels, formatValue: fmt });
    expect(middle.join(' ')).toContain('Delta');
    expect(middle.join(' ')).toContain('Bravo');
  });

  it('produces DIFFERENT prose for two pages of the same cohort', () => {
    const ranked = rankPeerRows(rows, true);
    const c = buildPeerProse({ locale: 'it', ranked, currentKey: 'c', labels, formatValue: fmt }).join(' ');
    const d = buildPeerProse({ locale: 'it', ranked, currentKey: 'd', labels, formatValue: fmt }).join(' ');
    expect(c).not.toEqual(d);
  });

  it('says so when the cohort is flat instead of inventing an ordering', () => {
    const flat: PeerRow[] = [
      { key: 'a', name: 'A', value: 7 },
      { key: 'b', name: 'B', value: 7 },
      { key: 'c', name: 'C', value: 7 },
    ];
    const prose = buildPeerProse({
      locale: 'it',
      ranked: rankPeerRows(flat, true),
      currentKey: 'b',
      labels,
      formatValue: fmt,
    }).join(' ');
    expect(prose).toContain('identica ovunque');
  });

  it('renders in all four locales', () => {
    const ranked = rankPeerRows(rows, true);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const prose = buildPeerProse({ locale, ranked, currentKey: 'c', labels, formatValue: fmt });
      expect(prose.length).toBeGreaterThanOrEqual(2);
      expect(prose.every((s) => s.trim().length > 0)).toBe(true);
    }
  });
});

describe('renderPeerComparison', () => {
  it('emits the block with links to the peers', () => {
    const html = renderPeerComparison({ locale: 'it', currentKey: 'c', rows, labels, formatValue: fmt });
    expect(html).toContain('data-peer-comparison="1"');
    expect(html).toContain('href="/delta/"');
    expect(html).toContain('Confronto');
  });

  it('is byte-stable across two builds with the rows in a different order', () => {
    const a = renderPeerComparison({ locale: 'it', currentKey: 'c', rows, labels, formatValue: fmt });
    const b = renderPeerComparison({
      locale: 'it',
      currentKey: 'c',
      rows: [...rows].reverse(),
      labels,
      formatValue: fmt,
    });
    expect(a).toEqual(b);
  });

  it('returns nothing rather than an empty promise when there is nothing to compare', () => {
    expect(renderPeerComparison({ locale: 'it', currentKey: 'a', rows: rows.slice(0, 2), labels, formatValue: fmt })).toBe('');
    expect(renderPeerComparison({ locale: 'it', currentKey: 'nope', rows, labels, formatValue: fmt })).toBe('');
  });

  it('escapes peer names and hrefs', () => {
    const nasty: PeerRow[] = [
      { key: 'a', name: '<script>', href: '/a"b/', value: 1 },
      { key: 'b', name: 'B', value: 2 },
      { key: 'c', name: 'C', value: 3 },
    ];
    const html = renderPeerComparison({ locale: 'it', currentKey: 'b', rows: nasty, labels, formatValue: fmt });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
