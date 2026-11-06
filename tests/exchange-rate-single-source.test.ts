import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { topLevelNames } from '../scripts/ci/lib/duplicateDeclarations.mjs';
import { DEFAULT_EXCHANGE_RATE } from '../constants';

/**
 * `main` shipped ONE quantity under TWO homonymous declarations pointing in
 * OPPOSITE directions (issue #5379).
 *
 *   constants.ts:1                        export const DEFAULT_EXCHANGE_RATE = 1.096;
 *   components/guide/PermitCompare.tsx:76 const DEFAULT_EXCHANGE_RATE = 0.94; // CHF → EUR fallback
 *
 * The whole app converts CHF to EUR by MULTIPLYING by the rate — see
 * `services/calculationService.ts:120` (`annualIncomeCHF * EXCHANGE_RATE`) and
 * its inverse at `:118` (`expensesTotalIT / EXCHANGE_RATE // Convert EUR to
 * CHF`), the UI label `1 CHF = {customExchangeRate} EUR`
 * (`components/calculator/InputCard.tsx:439`), and the daily snapshot the live
 * service caches (`data/exchange-rate-snapshot.json`, `currentRate: ~1.07`).
 * So `0.94` was not a different rate: it was the EUR→CHF reciprocal wearing the
 * CHF→EUR name, understating every euro figure in the permit comparison by
 * ~14% and then propagating non-linearly through the IRPEF brackets.
 *
 * Correcting the literal in place would have left the real defect standing —
 * two declarations of one quantity can always diverge again, and the *name*
 * being identical is what makes the divergence invisible in review. So the
 * local copy is gone and `PermitCompare.tsx` imports the exported one.
 *
 * This test is the gate that keeps it that way. It parses the real TypeScript
 * AST (not a regex over text, which would trip over the same identifier inside
 * a nested scope, a string, or a comment) and asserts that `DEFAULT_EXCHANGE_RATE`
 * is bound at MODULE scope in exactly one file: `constants.ts`.
 *
 * Scope note: `packages/articles/**` is deliberately excluded — the confinement
 * gate (`tests/packages-articles-confinement.test.ts`) forbids it to import
 * anything outside its own folder, so it could not consume `constants.ts` even
 * if it wanted to. `tests/**` is excluded too: a test-local literal is a fixture,
 * not a production source of truth.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const SYMBOL = 'DEFAULT_EXCHANGE_RATE';

/** Roots that hold shippable application code. */
const SOURCE_DIRS = ['components', 'services', 'hooks', 'build-plugins', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'packages', 'tests', '.git', 'public', 'data']);
const SOURCE_EXT = /\.(ts|tsx|mts|mjs)$/;

function walk(rel: string, out: string[]): void {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(childRel, out);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(childRel);
    }
  }
}

function rootLevelSources(): string[] {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && SOURCE_EXT.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => e.name);
}

const FILES: string[] = (() => {
  const out = rootLevelSources();
  for (const dir of SOURCE_DIRS) walk(dir, out);
  return out;
})();

/** Files whose text even mentions the symbol — the only ones worth parsing. */
const MENTIONING = FILES.filter((rel) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').includes(SYMBOL),
);

/** Files that BIND the symbol at module scope (declaration, not import/usage). */
const DECLARING = MENTIONING.filter((rel) => {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  return topLevelNames(src, rel).includes(SYMBOL);
});

describe('DEFAULT_EXCHANGE_RATE — one declaration, one direction', () => {
  it('scans a non-trivial source tree and actually reaches both sides of the old defect', () => {
    // Guards against a vacuous pass: an empty or mis-rooted file list would make
    // every assertion below trivially true.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain('constants.ts');
    expect(FILES).toContain(path.join('components', 'guide', 'PermitCompare.tsx'));
    // Both files must still mention the symbol — the consumer via its import.
    expect(MENTIONING).toContain('constants.ts');
    expect(MENTIONING).toContain(path.join('components', 'guide', 'PermitCompare.tsx'));
  });

  it('is declared at module scope in constants.ts and nowhere else', () => {
    expect(
      DECLARING,
      `${SYMBOL} must be declared exactly once, in constants.ts. These files redeclare it, ` +
        `which lets the same quantity drift into two values (and, as in #5379, two opposite ` +
        `directions) without a single review catching it — import it from '@/constants' ` +
        `instead: ${DECLARING.join(', ')}`,
    ).toEqual(['constants.ts']);
  });

  it('PermitCompare consumes the shared constant instead of redeclaring it', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'components', 'guide', 'PermitCompare.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bDEFAULT_EXCHANGE_RATE\b[^}]*\}\s*from\s*['"]@\/constants['"]/,
    );
  });

  it('holds the CHF→EUR direction, not its reciprocal', () => {
    // Every consumer multiplies a CHF amount by this to obtain euro. The
    // reciprocal (~0.9x) is the EUR→CHF direction and is exactly the value that
    // shipped in PermitCompare. A rate below 1 here means the direction flipped,
    // not that the market moved.
    expect(typeof DEFAULT_EXCHANGE_RATE).toBe('number');
    expect(DEFAULT_EXCHANGE_RATE).toBeGreaterThan(1);
    expect(DEFAULT_EXCHANGE_RATE).toBeLessThan(1.3);
  });

  it('the detector catches the exact shape that shipped (not vacuous)', () => {
    const preFix = [
      'import { useExchangeRate } from "@/services/exchangeRateService";',
      'const DEFAULT_EXCHANGE_RATE = 0.94; // CHF → EUR fallback',
      'function compare(g: number, r: number = DEFAULT_EXCHANGE_RATE) { return g * r; }',
    ].join('\n');
    expect(topLevelNames(preFix, 'PermitCompare.tsx')).toContain(SYMBOL);

    // …and does NOT mistake a plain import or a nested binding for a declaration.
    const clean = [
      'import { DEFAULT_EXCHANGE_RATE } from "@/constants";',
      'function compare(g: number, r: number = DEFAULT_EXCHANGE_RATE) {',
      '  const DEFAULT_EXCHANGE_RATE = 0.94;',
      '  return g * DEFAULT_EXCHANGE_RATE;',
      '}',
    ].join('\n');
    expect(topLevelNames(clean, 'PermitCompare.tsx')).not.toContain(SYMBOL);
  });
});
