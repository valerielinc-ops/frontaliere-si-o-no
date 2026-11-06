import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/pr-redflag-fixer.yml"), 'utf8');

describe('pr-redflag-fixer contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("PR 🔴 fixer");
    expect(SOURCE).toContain("pull_request_review");
    expect(SOURCE).toContain('EVENT_HEAD_SHA');
    expect(SOURCE).toContain('live_head_sha');
  });
});
