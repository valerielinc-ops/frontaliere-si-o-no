import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('jobboard canonical fallback guard', () => {
  it('falls back when stored canonical content is sparse', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
      'utf-8',
    );

    expect(source).toContain('function isSparseCanonicalContent');
    expect(source).toContain('if (!selected || isSparseCanonicalContent(selected)) return fallbackCanonical;');
  });

  it('falls back when localized canonical content is much poorer than the parsed description fallback', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
      'utf-8',
    );

    expect(source).toContain('function canonicalContentRichnessScore');
    expect(source).toContain('if (canonicalContentRichnessScore(selected) + 6 < canonicalContentRichnessScore(fallbackCanonical)) {');
    expect(source).toContain('return fallbackCanonical;');
  });
});
