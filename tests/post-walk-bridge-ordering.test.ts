import { describe, it, expect } from 'vitest';
import path from 'node:path';

import { partitionBridgesLast } from '../build-plugins/postWalkCoordinatorPlugin';

/**
 * Un bridge flat si deriva dal contenuto del fratello `X/index.html`. Se un
 * altro lavoratore riscrive il fratello mentre il bridge lo legge, il bridge
 * vede un file troncato e cambia da run a run. Il coordinatore esegue quindi
 * i bridge in una seconda fase, dopo che tutti gli altri file sono stati
 * elaborati.
 */
describe('post-walk: bridges run after every sibling has settled', () => {
  const d = '/dist';
  const set = new Set([
    `${d}/a/index.html`, `${d}/a.html`,
    `${d}/b/index.html`,
    `${d}/c.html`,            // flat senza fratello: non e' un bridge
    `${d}/.html`,
    `${d}/x/y/index.html`, `${d}/x/y.html`,
  ]);

  it('puts flat files with a sibling index.html last and keeps the union', () => {
    const paths = [`${d}/a.html`, `${d}/a/index.html`, `${d}/b/index.html`, `${d}/c.html`, `${d}/x/y.html`, `${d}/x/y/index.html`, `${d}/.html`];
    const { settledFirst, bridgesLast } = partitionBridgesLast(paths, set);
    expect(bridgesLast).toEqual([`${d}/a.html`, `${d}/x/y.html`]);
    expect(settledFirst).toEqual([`${d}/a/index.html`, `${d}/b/index.html`, `${d}/c.html`, `${d}/x/y/index.html`, `${d}/.html`]);
    expect([...settledFirst, ...bridgesLast].sort()).toEqual([...paths].sort());
  });

  it('never lets a sibling be processed in the same phase as its bridge', () => {
    const paths = [...set];
    const { settledFirst, bridgesLast } = partitionBridgesLast(paths, set);
    const first = new Set(settledFirst);
    for (const bridge of bridgesLast) {
      const sibling = path.join(bridge.slice(0, -'.html'.length), 'index.html');
      expect(first.has(sibling)).toBe(true);
      expect(bridgesLast.includes(sibling)).toBe(false);
    }
  });
});
