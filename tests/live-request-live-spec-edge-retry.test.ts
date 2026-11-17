import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const postDeploySource = readFileSync(new URL('./e2e/post-deploy-rendering-live.spec.ts', import.meta.url), 'utf8');
const sectorsSource = readFileSync(new URL('./e2e/sectors-landing-live.spec.ts', import.meta.url), 'utf8');

describe('live specs retry transient edge responses', () => {
  it('keeps post-deploy status checks on the retry helper and preserves tolerated 404 skips', () => {
    expect(postDeploySource).toContain("import { getLiveWithRetry, liveRequestTimeoutMs } from './lib/live-request';");
    expect(postDeploySource).toContain('liveRequestTimeoutMs(20_000)');
    expect(postDeploySource).toContain('liveRequestTimeoutMs(15_000) + 25_000');
    expect(postDeploySource).toMatch(
      /getLiveWithRetry(?:<APIResponse>)?\(request\.get\.bind\(request\), url, \{\s*maxRedirects: 5,\s*timeout: 20_000,\s*\}\)/,
    );
    expect(postDeploySource).toMatch(
      /getLiveWithRetry(?:<APIResponse>)?\(page\.request\.get\.bind\(page\.request\), url, \{\s*maxRedirects: 5,\s*timeout: 20_000,\s*\}\)/,
    );
    expect(postDeploySource).toMatch(
      /const headResponse = await getLiveWithRetry\(page\.request\.get\.bind\(page\.request\), url, \{\s*maxRedirects: 5,\s*timeout: 15_000,\s*\}\);\s*if \(headResponse\.status\(\) === 404 && target\.tolerate404\) \{\s*test\.skip\(true,/,
    );
    expect(postDeploySource).toMatch(
      /if \(fetched\.status === 404 && target\.tolerate404\) \{\s*test\.skip\(true,/,
    );
    expect(postDeploySource).toContain('expect(fetched.status, `${url} should return 200`).toBe(200);');
  });

  it('keeps sector landing 200 assertions on the retry helper and leaves 404 fail-closed', () => {
    expect(sectorsSource).toContain("import { getLiveWithRetry, liveRequestTimeoutMs } from './lib/live-request';");
    expect(sectorsSource).toContain('liveRequestTimeoutMs(20_000)');
    expect(sectorsSource).toMatch(
      /getLiveWithRetry(?:<APIResponse>)?\(request\.get\.bind\(request\), url, \{\s*maxRedirects: 5,\s*timeout: 20_000,?\s*\}\)/,
    );
    expect(sectorsSource).toContain("expect(status, `${URL} should return 200`).toBe(200);");
    expect(sectorsSource).not.toMatch(/status\s*===\s*404/);
  });
});
