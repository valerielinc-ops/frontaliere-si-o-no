import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/close-recovered-failure-issues.yml'), 'utf8');

describe('recovered failure issue workflow contract', () => {
  it('keeps the dry-run safety switch and deterministic reconciler', () => {
    expect(SOURCE).toContain('close-recovered-failure-issues.mjs');
    expect(SOURCE).toContain('--dry-run');
  });
});
