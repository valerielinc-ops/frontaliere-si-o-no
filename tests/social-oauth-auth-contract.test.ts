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
});
