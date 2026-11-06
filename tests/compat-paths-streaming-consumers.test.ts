import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('compat accumulator streaming consumers', () => {
  it('does not materialize the full path array in build-time consumers', () => {
    const jobsSeo = fs.readFileSync(
      path.resolve(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    const enrichment = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/enrich-compat-orphan-slugs.mjs'),
      'utf8',
    );
    const backfill = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/backfill-slug-aliases.mjs'),
      'utf8',
    );

    expect(jobsSeo).toContain('iterateCompatPaths(rootDir)');
    expect(jobsSeo).not.toContain('readCompatPaths(rootDir).paths');
    expect(enrichment).toContain('iterateCompatPaths(ROOT)');
    expect(enrichment).not.toContain('readCompatPaths(ROOT)');
    expect(backfill).toContain('iterateCompatPaths(ROOT)');
    expect(backfill).not.toContain('readCompatPaths(ROOT)');
  });
});
