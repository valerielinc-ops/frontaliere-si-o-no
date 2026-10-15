import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Schindler dedicated crawler localization flow', () => {
  // The Schindler crawler now delegates to the standard pipeline, which runs
  // shared localization + locale validation in a fixed order. The test ensures
  // the runner stays wired to that pipeline rather than reintroducing a
  // bespoke localization pass that bypasses validation.
  it('delegates to the shared crawler pipeline', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/update-schindler-jobs.mjs'),
      'utf-8',
    );

    expect(source).toContain('runStandardCrawlerPipeline');
    expect(source).toMatch(/from\s+['"]\.\/lib\/crawler-template\.mjs['"]/);
    expect(source).toContain('fetchAllSchindlerJobs');
    expect(source).toContain('isSchindlerJob');
  });
});
