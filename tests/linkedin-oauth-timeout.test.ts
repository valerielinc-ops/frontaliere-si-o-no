import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../functions/src/linkedinAuthCallback.js'), 'utf8');

describe('LinkedIn OAuth callback', () => {
  it('bounds the authorization-code token exchange request', () => {
    const handlerStart = source.indexOf('export async function handleLinkedInCallback');
    const exchangeEnd = source.indexOf('\n // ── Fetch user profile', handlerStart);
    const exchange = source.slice(handlerStart, exchangeEnd);

    expect(exchangeEnd).toBeGreaterThan(handlerStart);
    expect(source).toContain('const LINKEDIN_REQUEST_TIMEOUT_MS = 30_000;');
    expect(exchange).toContain('signal: AbortSignal.timeout(LINKEDIN_REQUEST_TIMEOUT_MS)');
  });
});
