import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dirname, '../scripts/ci/check-main-ruleset-invariants.mjs'),
  'utf8',
);

describe('main ruleset invariant GitHub API transport', () => {
  it('bounds both the ruleset list and detail reads', () => {
    const ghJson = source.slice(
      source.indexOf('async function ghJson('),
      source.indexOf('\n\nasync function main()', source.indexOf('async function ghJson(')),
    );

    expect(source).toContain('const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000;');
    expect(ghJson).toContain('signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS)');
  });
});
