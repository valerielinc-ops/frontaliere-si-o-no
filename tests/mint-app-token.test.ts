import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildAppJwt, hasWorkflowsWrite } from '../scripts/ci/mint-app-token.mjs';

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

/**
 * Capability VERIFIED, not asserted (#5288).
 *
 * A successful mint is not evidence of what the token can do: `access_tokens` returns 201
 * and a usable token even when the App's `workflows` permission was requested but never
 * approved on the installation — it simply is absent from `permissions`. issue-fix.yml
 * used to infer the scope from the token merely existing, so the fixer was told "you have
 * `workflows`, proceed", implemented the whole fix, and only then had the push rejected
 * ("refusing to allow a GitHub App to create or update workflow ... without `workflows`
 * permission", #5280) — moving the failure from turn 1 (0 tokens) to post-implementation
 * (~1M tokens). These two cases are the whole decision.
 */
describe('hasWorkflowsWrite — the two conditions that decide the capability gate', () => {
  it('permission GRANTED → true (the only shape that unlocks .github/workflows/** pushes)', () => {
    expect(hasWorkflowsWrite({ contents: 'write', workflows: 'write' })).toBe(true);
  });

  it('permission ABSENT (requested but never approved on the installation) → false', () => {
    // The exact live shape behind #5280: a perfectly valid token, no `workflows` key.
    expect(hasWorkflowsWrite({ contents: 'write', issues: 'write', pull_requests: 'write' })).toBe(false);
  });

  it('read-only grant → false (a push would still be rejected server-side)', () => {
    expect(hasWorkflowsWrite({ workflows: 'read' })).toBe(false);
  });

  it('missing/malformed permissions → false (fail-closed, never "granted" by accident)', () => {
    expect(hasWorkflowsWrite(undefined)).toBe(false);
    expect(hasWorkflowsWrite(null)).toBe(false);
    expect(hasWorkflowsWrite({})).toBe(false);
  });
});

/**
 * The pure helper above is worthless if issue-fix.yml keeps gating on token PRESENCE —
 * that mismatch (script correct, wiring stale) is exactly the failure mode #4227
 * documented for check-workflows-scope.mjs, which sat orphaned for a whole escalation
 * cycle. Lock the wiring itself.
 */
describe('issue-fix.yml wiring — gates on capability, never on token presence (#5288)', () => {
  const yml = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');

  it('the workflows-scope pre-flight guard is gated on APP_TOKEN_WORKFLOWS != true', () => {
    expect(yml).toContain("if: env.APP_TOKEN_WORKFLOWS != 'true'");
  });

  it('the agent capability-guard prompt branches on APP_TOKEN_WORKFLOWS, not on APP_TOKEN', () => {
    // 2026-08-30: the branch moved out of the inline `${{ cond && 'A' || 'B' }}`
    // prompt expression into the "Determine fix tier" step's bash script — see
    // issue-fix-app-token-wiring.test.ts for why (prompt scalar size limit).
    // The prompt line now just references the computed output.
    const line = yml.split('\n').find((l) => l.includes('**Capability guard'));
    expect(line).toBeDefined();
    expect(line).toContain('${{ steps.tier.outputs.capability_guard }}');

    expect(yml).toMatch(/APP_TOKEN_WORKFLOWS:-\}"\s*=\s*"true"/);
    expect(yml).not.toContain("env.APP_TOKEN != ''");
  });

  it('no step decides workflows capability from the mere presence of APP_TOKEN', () => {
    // `env.APP_TOKEN == ''` / `!= ''` was the old, wrong proxy for the capability.
    expect(yml).not.toMatch(/if: env\.APP_TOKEN\s*[=!]=\s*''/);
  });
});
