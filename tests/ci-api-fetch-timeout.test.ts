import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FILES = [
  'scripts/ci/check-main-ruleset-invariants.mjs',
  'scripts/ci/check-shard-secret-shadowing.mjs',
  'scripts/ci/reap-stale-deploy-build.mjs',
];

describe('CI GitHub API requests', () => {
  it('apply a finite timeout to reads and cancellation', () => {
    for (const relativePath of FILES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).toMatch(/(?:const|export const) GITHUB_API_TIMEOUT_MS = (?:20_000|30_000);/);
      expect(source, relativePath).toContain('AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)');
    }
  });
});
