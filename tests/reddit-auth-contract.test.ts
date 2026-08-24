import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the three Reddit-specific invariants of scripts/reddit-auth.mjs.
 *
 * The source is SCANNED AS TEXT, never imported: reddit-auth.mjs calls main()
 * at module scope, so importing it would start a real OAuth flow and bind a
 * listener on :8080 during the test run.
 *
 * All three failures below are silent — the flow still "succeeds" and the
 * breakage only shows up later as a poster that no-ops, which is the exact
 * failure mode this whole branch exists to remove.
 */
const SRC = readFileSync(
  resolve(__dirname, '..', 'scripts', 'reddit-auth.mjs'),
  'utf8',
);

describe('reddit-auth.mjs OAuth contract', () => {
  it("requests duration=permanent (without it Reddit never returns a refresh_token)", () => {
    expect(SRC).toMatch(/set\(\s*['"]duration['"]\s*,\s*['"]permanent['"]\s*\)/);
    expect(SRC).not.toMatch(/['"]temporary['"]/);
  });

  it('authenticates the token exchange with HTTP Basic, not body credentials', () => {
    // Reddit returns 401 when client_id/client_secret are sent in the form
    // body — it reads like a wrong secret and sends you debugging the wrong
    // thing. reddit-client.mjs uses Basic; this helper must match.
    expect(SRC).toMatch(/Basic \$\{basic\}/);
    const body = SRC.slice(SRC.indexOf('grant_type: \'authorization_code\''));
    expect(body.slice(0, 300)).not.toMatch(/client_secret\s*[,:]/);
  });

  it('sends a User-Agent on every Reddit call (Reddit throttles anonymous UAs)', () => {
    const fetchCalls = SRC.match(/fetch\(/g) || [];
    const uaUses = SRC.match(/'User-Agent':\s*userAgent\(\)/g) || [];
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(uaUses.length).toBe(fetchCalls.length);
  });

  it('tells the operator the RC-side name (SERVER_ prefix), not the env name', () => {
    // RC_TO_ENV renames SERVER_REDDIT_REFRESH_TOKEN → REDDIT_REFRESH_TOKEN.
    // Printing the env name would have the owner store a parameter that no
    // loader maps, and the token would be inert in Remote Config.
    expect(SRC).toMatch(/SERVER_REDDIT_REFRESH_TOKEN=/);
  });
});
