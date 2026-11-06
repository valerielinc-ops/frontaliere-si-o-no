import { describe, expect, it } from 'vitest';
import { exactPortalVerificationUrl } from '../functions/src/assistedApplicationPortalSites.js';

describe('exact portal verification URL', () => {
  const host = 'victim.wd3.myworkdayjobs.com';
  it('preserves the complete native token on the exact account host', () => {
    const url = `https://${host}/verify?t=abc%2Fxyz.!`;
    expect(exactPortalVerificationUrl(url, host.toUpperCase())).toBe(url);
  });
  it.each([
    ['https://attacker.wd1.myworkdayjobs.com/verify', host],
    ['https://attacker.myworkday.com/verify', host],
    ['https://evil.co.uk/verify', 'careers.foo.co.uk'],
    [`http://${host}/verify`, host],
    [`https://${host}@evil.example/verify`, host],
    [`https://user:pass@${host}/verify`, host],
    [`https://${host}:8443/verify`, host],
    [`https://${host}.evil.example/verify`, host],
    [`https://${host}./verify`, host],
    [`https://${host}/verify\u000a`, host],
    [`https://${host}/verify?token=${'x'.repeat(2000)}`, host],
  ])('rejects unsupported target %s', (url, accountHost) => {
    expect(exactPortalVerificationUrl(url, accountHost)).toBe('');
  });
});
