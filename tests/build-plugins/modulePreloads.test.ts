/**
 * Gate: a static page's <head> never hints the same modulepreload twice.
 *
 * Live 2026-10-24, /calcola-stipendio/: `it-calculator.js` was modulepreloaded
 * by the core list AND by the calculator section's locale-chunk preload.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routeModulePreloadTags } from '../../build-plugins/shared/modulePreloads';

describe('routeModulePreloadTags', () => {
  it('drops a route chunk the core list already preloads (the calculator case)', () => {
    const core = new Set(['vendor-react.js', 'it-core.js', 'it-calculator.js']);
    expect(routeModulePreloadTags(['InputCard.js', 'it-calculator.js'], core)).toEqual([
      '<link rel="modulepreload" href="/assets/InputCard.js">',
    ]);
  });

  it('drops repeats inside the route list and empty entries, keeping order', () => {
    expect(routeModulePreloadTags(['A.js', '', null, 'B.js', 'A.js', undefined], new Set())).toEqual([
      '<link rel="modulepreload" href="/assets/A.js">',
      '<link rel="modulepreload" href="/assets/B.js">',
    ]);
  });

  it('does not mutate the core set', () => {
    const core = new Set(['it-core.js']);
    routeModulePreloadTags(['X.js'], core);
    expect([...core]).toEqual(['it-core.js']);
  });
});

describe('staticPagesPlugin wires every route-chunk modulepreload through the helper', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../build-plugins/staticPagesPlugin.ts'), 'utf8');

  it('the only literal modulepreload tags are the core list', () => {
    const literal = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /<link rel="modulepreload"/.test(line) && !line.startsWith('//'));
    // The two core-list lines (vendor-react with crossorigin, the IT critical chunks).
    expect(literal.map(({ line }) => line)).toEqual([
      expect.stringContaining('vendorReactChunk'),
      expect.stringContaining('itCriticalChunks.map'),
    ]);
  });

  it('the page list is deduplicated against the core list', () => {
    expect(src).toMatch(/routeModulePreloadTags\(routeChunks, corePreloadedChunks\)/);
    expect(src).toMatch(/corePreloadedChunks[^=]*= new Set\(\[vendorReactChunk, \.\.\.itCriticalChunks\]/);
  });
});
