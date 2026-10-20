import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ISSUES_CEILING_BYTES = 22_000;
const issuesPath = resolve(import.meta.dirname, '../ISSUES.md');

describe('ISSUES.md contract ceiling', () => {
  it('stays within the documented 22,000-byte ceiling', () => {
    const size = Buffer.byteLength(readFileSync(issuesPath, 'utf8'), 'utf8');
    expect(size).toBeLessThanOrEqual(ISSUES_CEILING_BYTES);
  });
});
