import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Manor dedicated crawler localization flow', () => {
  it('runs the shared localization pass before strict locale validation', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/update-manor-jobs.mjs'),
      'utf-8',
    );

    expect(source).toContain('runDedicatedBaseCrawler');
    expect(source).toContain("console.log('🚀 Running shared crawler for AI localization...')");
    expect(source).toContain('await runBaseCrawler();');

    const runIndex = source.indexOf('await runBaseCrawler();');
    const validateIndex = source.indexOf('validateLocales();');
    expect(runIndex).toBeGreaterThan(-1);
    expect(validateIndex).toBeGreaterThan(runIndex);
  });
});
