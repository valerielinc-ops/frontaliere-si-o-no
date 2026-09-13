import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// These parsers share the Workday contract: the human-readable `contract`
// field must be derived from the same employmentType emitted for the listing.
// Keep the sibling set explicit so a future parser copied from the old Abbott
// shape cannot silently reintroduce `contract: 'full-time'` for part-time jobs.
const SIBLING_PARSERS = [
  'scripts/lib/abbott-job-parser.mjs',
  'scripts/lib/alcon-job-parser.mjs',
  'scripts/lib/ardian-job-parser.mjs',
  'scripts/lib/csl-behring-job-parser.mjs',
  'scripts/lib/medtronic-job-parser.mjs',
  'scripts/lib/rituals-cosmetics-job-parser.mjs',
  'scripts/lib/stryker-job-parser.mjs',
];

describe('Workday sibling employment contract mapping', () => {
  it('derives contract from the parser employmentType in every affected sibling', () => {
    for (const parserPath of SIBLING_PARSERS) {
      const source = readFileSync(resolve(__dirname, '..', parserPath), 'utf8');
      expect(source, parserPath).toMatch(/const employmentType\s*=\s*detectEmploymentType\s*\(/);
      expect(source, parserPath).toMatch(
        /contract:\s*employmentType\s*===\s*['"]PART_TIME['"]\s*\?\s*['"]part-time['"]\s*:\s*['"]full-time['"]/
      );
    }
  });
});
