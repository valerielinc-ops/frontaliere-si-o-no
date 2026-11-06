import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/recycle-stale-prs.yml'), 'utf8');

describe('recycle stale PRs contract', () => {
  it('keeps the source-backed stale-review recycling guard explicit', () => {
    expect(SOURCE).toContain('Recycle stale PRs');
    expect(SOURCE).toContain('stale-review');
  });
});
