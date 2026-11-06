import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/triage-sweep.mjs'), 'utf8');

describe('triage sweep contract', () => {
  it('keeps idempotent triage labels and a bounded dry-run mode', () => {
    expect(SOURCE).toContain('agent:triaged');
    expect(SOURCE).toContain('ROUTING_LABELS');
    expect(SOURCE).toContain('--dry-run');
  });
});
