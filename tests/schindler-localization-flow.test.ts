import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Schindler dedicated crawler localization flow', () => {
  it('runs shared localization before strict locale validation', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/update-schindler-jobs.mjs'),
      'utf-8',
    );

    expect(source).toContain('runDedicatedBaseCrawler');
    expect(source).toContain('await runBaseCrawler();');

    const runIndex = source.indexOf('await runBaseCrawler();');
    const validateIndex = source.indexOf('validateSchindlerLocaleCoverage();');
    expect(runIndex).toBeGreaterThan(-1);
    expect(validateIndex).toBeGreaterThan(runIndex);
  });
});
