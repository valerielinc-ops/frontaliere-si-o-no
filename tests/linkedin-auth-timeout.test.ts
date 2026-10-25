import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dirname, '../functions/src/linkedinAuthCallback.js'),
  'utf8',
);

describe('LinkedIn auth provider requests', () => {
  it('bounds every outbound request without changing the best-effort profile fallback', () => {
    expect(source).toContain('const LINKEDIN_REQUEST_TIMEOUT_MS = 30_000;');

    const requests = [
      source.slice(
        source.indexOf('async function fetchLinkedInBasicProfile'),
        source.indexOf('/**\n * Enrich newsletter_subscribers'),
      ),
      source.slice(
        source.indexOf("const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken'"),
        source.indexOf('if (!tokenRes.ok)', source.indexOf('const tokenRes = await fetch(')),
      ),
      source.slice(
        source.indexOf("const userRes = await fetch('https://api.linkedin.com/v2/userinfo'"),
        source.indexOf('if (!userRes.ok)', source.indexOf('const userRes = await fetch(')),
      ),
    ];

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toContain('signal: AbortSignal.timeout(LINKEDIN_REQUEST_TIMEOUT_MS)');
    }

    const profile = requests[0];
    expect(profile).toContain('return { headline: null, vanityName: null };');
  });
});
