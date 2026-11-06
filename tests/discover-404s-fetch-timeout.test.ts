import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(ROOT, 'scripts/discover-404s-via-inspection.mjs'), 'utf8');

describe('Search Console inspection requests', () => {
  it('routes OAuth, property discovery, and URL inspection through one bounded fetch helper', () => {
    expect(source).toContain('const INSPECTION_FETCH_TIMEOUT_MS');
    expect(source).toContain('AbortSignal.timeout(INSPECTION_FETCH_TIMEOUT_MS)');
    expect(source.match(/fetchInspection\(/g)).toHaveLength(4);
    expect(source.match(/await fetch\(/g) || []).toHaveLength(0);
  });
});
