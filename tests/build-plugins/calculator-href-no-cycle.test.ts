/**
 * Guard: build-plugins/shared/calculatorHref.ts must stay a LEAF module and
 * cantonSeoProse must never import from jobBoardCommuterContext.
 *
 * jobBoardCommuterContext imports cantonSeoProse; when PR #1938 made
 * cantonSeoProse import CALC_HREF back from commuterContext, the ESM cycle
 * left the const `undefined` in the production build's evaluation order
 * ("Cannot read properties of undefined (reading 'it')" in
 * renderCantonSeoProse — deploy run 27402547466) while vitest's different
 * entry order masked it. Module-graph shape is the only deterministic way
 * to pin this, so the test asserts the import structure itself.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SHARED = path.resolve(__dirname, '../../build-plugins/shared');

function read(name: string): string {
  return fs.readFileSync(path.join(SHARED, name), 'utf-8');
}

describe('calculatorHref module graph', () => {
  it('calculatorHref.ts is a leaf (no relative imports)', () => {
    const src = read('calculatorHref.ts');
    expect(src).not.toMatch(/^import .*from '\.\.?\//m);
  });

  it('cantonSeoProse does not import from jobBoardCommuterContext (ESM cycle)', () => {
    const src = read('cantonSeoProse.ts');
    expect(src).not.toContain("from './jobBoardCommuterContext'");
  });

  it('CALC_HREF resolves with real values through the re-export', async () => {
    const mod = await import('../../build-plugins/shared/jobBoardCommuterContext');
    expect(mod.CALC_HREF.it).toBe('/calcola-stipendio/');
    const leaf = await import('../../build-plugins/shared/calculatorHref');
    expect(leaf.CALC_HREF).toEqual(mod.CALC_HREF);
  });
});
