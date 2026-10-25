import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dirname, '../functions/src/linkedinAuthCallback.js'),
  'utf8',
);

describe('LinkedIn auth provider requests', () => {
  it('bounds every LinkedIn request without changing the response contract', () => {
    expect(source).toContain('const LINKEDIN_REQUEST_TIMEOUT_MS = 12_000;');
    expect(source.match(/signal: AbortSignal\.timeout\(LINKEDIN_REQUEST_TIMEOUT_MS\)/g))
      .toHaveLength(3);
    expect(source.match(/await fetchLinkedIn\(/g)).toHaveLength(3);
    expect(source).toContain('throw new Error(`LinkedIn userinfo request failed: ${userRes.status}`);');
    expect(source).toContain('return { headline: null, vanityName: null };');
  });
});
