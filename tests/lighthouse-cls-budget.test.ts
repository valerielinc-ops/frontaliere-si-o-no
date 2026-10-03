import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Ratchet guard for the Lighthouse CI CLS budgets (lighthouserc.json = mobile,
 * lighthouserc.desktop.json = desktop).
 *
 * Both files describe themselves as baseline-locking regression detectors to be
 * "ratcheted DOWN as pages improve — never up". Nothing enforced that, so the
 * /cerca-lavoro-ticino/ debt-marker block kept the CLS ceilings it was given on
 * 2026-08-07 (1.0 mobile, 0.7 desktop) long after the page dropped to a
 * representative 0.07 / 0.024: a static->SPA handoff regression back to 0.58
 * would have passed the lab leg green.
 *
 * CLS_CEILINGS holds the values committed with the last ratchet. A config value
 * ABOVE its ceiling is red (a threshold was raised, or a new group appeared
 * without a measured ceiling). A value BELOW passes — whoever ratchets further
 * lowers the table in the same PR. Never raise a number here to make a red
 * Lighthouse run go away: read the report and treat it as a regression.
 *
 * Measurement behind the ticino values (2026-10-03): worst representative
 * (median-of-3) /cerca-lavoro-ticino/ report of scheduled lighthouse-ci.yml
 * runs 37114430116 / 36995734554 / 36852178775 = 0.0715 mobile, 0.0243 desktop;
 * ceiling = max(0.10, 2x worst rounded up to 0.05). See
 * docs/CWV-FIELD-CRITERION.md section 6.
 */

const TICINO_PATTERN = '^https://frontaliereticino\\.ch/cerca-lavoro-ticino/';
const HEALTHY_MARKER = '(?!cerca-lavoro-ticino/)';
// Absolute ceiling for the debt-marker block, independent of the table: a
// carve-out may never again tolerate a "poor" layout shift (web.dev: > 0.25).
const TICINO_ABSOLUTE_MAX = 0.25;

const CLS_CEILINGS: Record<string, { healthy: number; ticino: number }> = {
  'lighthouserc.json': { healthy: 0.45, ticino: 0.15 },
  'lighthouserc.desktop.json': { healthy: 0.15, ticino: 0.1 },
};

type Assertion = [string, { maxNumericValue?: number }];
type Block = { '//'?: string; matchingUrlPattern: string; assertions: Record<string, Assertion> };

const read = (file: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as { ci: { assertMatrix: Block[] } };

const groupOf = (pattern: string): 'healthy' | 'ticino' | null => {
  if (pattern === TICINO_PATTERN) return 'ticino';
  if (pattern.includes(HEALTHY_MARKER)) return 'healthy';
  return null;
};

describe('Lighthouse CI CLS budgets only ratchet down', () => {
  describe.each(Object.keys(CLS_CEILINGS))('%s', (file) => {
    const matrix = read(file).ci.assertMatrix;
    const clsBlocks = matrix.filter((b) => b.assertions?.['cumulative-layout-shift']);

    it('has CLS-gated blocks to check (the guard is not vacuous)', () => {
      expect(clsBlocks.length).toBeGreaterThan(0);
    });

    it('keeps every CLS ceiling at or below the last committed ratchet', () => {
      for (const block of clsBlocks) {
        const group = groupOf(block.matchingUrlPattern);
        expect(group, `unclassified CLS block ${block.matchingUrlPattern}: add it to CLS_CEILINGS`).not.toBeNull();
        const [level, opts] = block.assertions['cumulative-layout-shift'];
        expect(level, `${block.matchingUrlPattern} CLS must stay an error, not a warning`).toBe('error');
        expect(typeof opts.maxNumericValue).toBe('number');
        expect(
          opts.maxNumericValue,
          `Lighthouse CLS budget: soglia ${block.matchingUrlPattern} alzata o oltre la misura`,
        ).toBeLessThanOrEqual(CLS_CEILINGS[file][group!]);
      }
    });

    it('never lets the /cerca-lavoro-ticino/ debt marker tolerate a poor CLS', () => {
      const ticino = clsBlocks.filter((b) => b.matchingUrlPattern === TICINO_PATTERN);
      for (const block of ticino) {
        expect(block.assertions['cumulative-layout-shift'][1].maxNumericValue).toBeLessThanOrEqual(
          TICINO_ABSOLUTE_MAX,
        );
      }
    });

    it('dates the measurement behind every CLS ceiling', () => {
      for (const block of clsBlocks) {
        expect(block['//'] ?? '', `${block.matchingUrlPattern} needs a dated "//" note`).toMatch(
          /20\d\d-\d\d-\d\d/,
        );
      }
    });
  });
});
