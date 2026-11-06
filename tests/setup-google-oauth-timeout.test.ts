import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../scripts/setup-google-oauth.mjs'), 'utf8');

describe('Google OAuth setup', () => {
  it('bounds the authorization-code token exchange request', () => {
    const exchange = source.slice(
      source.indexOf('async function exchangeCode('),
      source.indexOf('\n// ── Start local server', source.indexOf('async function exchangeCode(')),
    );

    expect(source).toContain('const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;');
    expect(exchange).toContain('signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)');
  });
});
