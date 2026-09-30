import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('comparisons hub table accessibility', () => {
  it('associates every comparison table with its visible section caption', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/comparisonsHubPlugin.ts'), 'utf8');
    const tableOpenings = source.match(/<table class="[^"]+">\s*<caption class="sr-only">/g) ?? [];

    expect(tableOpenings).toHaveLength(5);
    for (const captionKey of ['tSalaryCaption', 'tTaxCaption', 'tHealthCaption', 'tBenefitsCaption', 'tCostCaption']) {
      expect(source).toContain(`<caption class="sr-only">${'${esc(copy.'}${captionKey})}</caption>`);
    }
  });
});
