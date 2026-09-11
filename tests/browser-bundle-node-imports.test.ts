/**
 * Il grafo dei moduli dell'entry SPA non contiene builtin Node (#8125).
 *
 * Perche' un test e non un warning tollerato: rollup risolve un builtin Node a
 * `__vite-browser-external`, che non ha export nominati. Un import NOMINALE non
 * risolve e il link FALLISCE; un import namespace o di default resta un
 * warning. Le due forme sono lo stesso difetto — il warning diventa fatale il
 * giorno in cui qualcuno riscrive `import * as _fs from 'node:fs'` come
 * `import { readFileSync } from 'node:fs'` — e il costo si paga al link, cioe'
 * dopo ~80 minuti di build per locale: fra il 2026-09-08T15:18Z e il
 * 2026-09-09 nessun deploy e' arrivato in fondo.
 *
 * L'arco verso `build-plugins/**` NON e' il difetto e non va tagliato: la SPA
 * condivide con l'emettitore SSG i costruttori di path e gli elenchi di slug
 * perche' la forma degli URL abbia una sola sorgente. Il difetto e' un modulo
 * che MESCOLA quei costruttori con il codice di build che legge da disco.
 */
import { describe, it, expect } from 'vitest';
import { measureBrowserGraph } from '../scripts/ci/check-browser-bundle-node-imports.mjs';

describe('bundle browser: nessun builtin Node nel grafo dell\'entry SPA', () => {
  it('conta 0 foglie con import Node', () => {
    const { moduleCount, leaves } = measureBrowserGraph();

    // Il grafo e' vivo: se il camminatore non risolvesse piu' niente, "0
    // foglie" sarebbe vero e privo di significato.
    expect(moduleCount).toBeGreaterThan(400);

    const detail = leaves
      .map((leaf) => `${leaf.file} -> ${leaf.builtins.join(', ')}\n  catena: ${leaf.chain.join(' -> ')}`)
      .join('\n');
    expect(leaves, `foglie con import Node nel grafo SPA:\n${detail}`).toEqual([]);
  });

  it('keeps the Node-backed build wrappers outside the SPA graph', () => {
    const { reachableFiles } = measureBrowserGraph();

    expect(reachableFiles).toEqual(expect.arrayContaining([
      'build-plugins/shared/healthPremiumsPaths.ts',
    ]));
    expect(reachableFiles).not.toEqual(expect.arrayContaining([
      'build-plugins/healthPremiumsData.ts',
      'build-plugins/jobBoardSeo.ts',
      'build-plugins/shared/seoContentTokens.ts',
    ]));
  });
});
