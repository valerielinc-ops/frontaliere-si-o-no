import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/lib/atomic-write-json.mjs"), 'utf8');

describe('atomic-write-json contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("assertCrawlerSliceWriteSafe");
    expect(SOURCE).toContain("preserveSlugHistory");
  });
});
