import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('GitHub proxy upstream requests', () => {
  it('bounds feedback, admin, and redirected log requests', () => {
    const source = readFileSync(resolve(ROOT, 'functions/src/githubProxy.js'), 'utf8');
    expect(source).toContain('const FEEDBACK_GITHUB_TIMEOUT_MS = 20_000;');
    expect(source).toContain('const GITHUB_REQUEST_TIMEOUT_MS = 15_000;');
    expect(source).toContain('signal: AbortSignal.timeout(FEEDBACK_GITHUB_TIMEOUT_MS)');
    expect(source.match(/signal: AbortSignal\.timeout\(GITHUB_REQUEST_TIMEOUT_MS\)/g)).toHaveLength(3);
    expect(source).toContain('upstream = await fetchImpl(githubUrl, requestOptions);');
    expect(source).toContain('const logResponse = await fetchImpl(upstream.headers.get(\'location\'), {');
  });
});
