import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const AUTH_SCRIPTS = [
  'linkedin-member-auth.mjs',
  'reddit-auth.mjs',
  'tiktok-auth.mjs',
];

describe('social OAuth authentication helpers', () => {
  it.each(AUTH_SCRIPTS)('%s validates private storage before requesting a one-use code', (file) => {
    const source = readFileSync(resolve(__dirname, '..', 'scripts', file), 'utf8');
    const preflight = source.indexOf('await validateSocialOAuthCredentialStorage');
    const listener = source.indexOf('const code = await new Promise');
    expect(preflight).toBeGreaterThan(-1);
    expect(listener).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(listener);
    expect(source).toContain('readSocialOAuthStorageCredentials');
  });

  it.each(AUTH_SCRIPTS)('%s never logs token values or raw exchange payloads', (file) => {
    const source = readFileSync(resolve(__dirname, '..', 'scripts', file), 'utf8');
    expect(source).toContain('persistSocialOAuthCredentials');
    expect(source).not.toMatch(/console\.(?:log|error)\([^;\n]*tokens\.(?:access|refresh)_token/);
    expect(source).not.toContain('JSON.stringify(data)');
  });

  it('fails closed on a missing or wrong consented social account identity', () => {
    const reddit = readFileSync(resolve(__dirname, '..', 'scripts', 'reddit-auth.mjs'), 'utf8');
    const linkedin = readFileSync(resolve(__dirname, '..', 'scripts', 'linkedin-member-auth.mjs'), 'utf8');
    const tiktok = readFileSync(resolve(__dirname, '..', 'scripts', 'tiktok-auth.mjs'), 'utf8');

    expect(reddit).toContain('EXPECTED_USERNAME');
    expect(reddit).toContain('normalizeUsername(who) !== normalizeUsername(EXPECTED_USERNAME)');
    expect(reddit).toContain('const who = await whoAmI(tokens.access_token)');
    expect(linkedin).toContain('urn !== expectedUrn');
    expect(linkedin).toContain('if (!urn)');
    expect(tiktok).toContain('identity.username');
    expect(tiktok).toContain('identity.open_id');
    expect(tiktok).toContain("[prefix + 'OPEN_ID']");
  });

  it.each(AUTH_SCRIPTS)('%s binds its one-shot callback only to loopback', (file) => {
    const source = readFileSync(resolve(__dirname, '..', 'scripts', file), 'utf8');
    expect(source).toContain("server.listen(PORT, LISTEN_HOST,");
    expect(source).toContain('must use a loopback redirect URI');
    expect(source).not.toMatch(/server\.listen\(PORT,\s*\(\)/u);
  });
});
