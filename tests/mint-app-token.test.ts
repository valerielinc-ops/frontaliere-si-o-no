import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildAppJwt } from '../scripts/ci/mint-app-token.mjs';

// Deterministic test keypair (no network, no real App key).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const NOW = 1_700_000_000;

function decode(part: string) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('buildAppJwt', () => {
  it('produces a 3-part JWT with RS256 header and the app id as issuer', () => {
    const jwt = buildAppJwt('4131376', PEM, NOW);
    const [h, p] = jwt.split('.');
    expect(jwt.split('.')).toHaveLength(3);
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = decode(p);
    expect(payload.iss).toBe('4131376');
    expect(payload.iat).toBe(NOW - 60); // back-dated for clock skew
    expect(payload.exp).toBe(NOW + 540); // under GitHub's 10-min cap
  });

  it('signs the header.payload so it verifies against the public key', () => {
    const jwt = buildAppJwt('4131376', PEM, NOW);
    const [h, p, sig] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    v.end();
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('coerces a numeric app id to string in the issuer claim', () => {
    const jwt = buildAppJwt(4131376 as unknown as string, PEM, NOW);
    expect(decode(jwt.split('.')[1]).iss).toBe('4131376');
  });
});
