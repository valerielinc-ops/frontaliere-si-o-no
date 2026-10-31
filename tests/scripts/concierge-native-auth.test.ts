import { describe, expect, it } from 'vitest';
import { nativeConciergeAuth } from '../../.github/actions/setup-codex-darwin-broker/native-auth.mjs';

const nowMs = Date.now();
const jwt = (claims: unknown) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
const source = () => ({ auth_mode: 'chatgpt', tokens: {
  access_token: jwt({ exp: Math.floor(nowMs / 1000) + 7200 }),
  id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
  account_id: 'synthetic-account',
}, last_refresh: new Date(nowMs - 60_000).toISOString() });

describe('Darwin concierge native external auth adapter', () => {
  it('preserves original identity and timestamp while making the required refresh field empty', () => {
    const input = source();
    expect(JSON.parse(nativeConciergeAuth(JSON.stringify(input), { nowMs }))).toEqual({
      ...input, auth_mode: 'chatgptAuthTokens', tokens: { ...input.tokens, refresh_token: '' },
    });
  });
  it('discards a supplied refresh credential and never fabricates an absent timestamp', () => {
    const { last_refresh: ignored, ...input } = source();
    const result = JSON.parse(nativeConciergeAuth(JSON.stringify({ ...input,
      tokens: { ...input.tokens, refresh_token: 'synthetic-refresh-never-forwarded' }, extra: 'ignored' }), { nowMs }));
    expect(result.tokens.refresh_token).toBe('');
    expect(result).not.toHaveProperty('last_refresh');
    expect(result).not.toHaveProperty('extra');
  });
  it.each([
    ['expired access', { tokens: { access_token: jwt({ exp: Math.floor(nowMs / 1000) - 1 }) } }],
    ['invalid ID JWT', { tokens: { id_token: 'not-a-jwt' } }],
    ['invalid native ID claim', { tokens: { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 12 } }) } }],
    ['invalid native profile claim', { tokens: { id_token: jwt({ 'https://api.openai.com/profile': [] }) } }],
    ['invalid timestamp', { last_refresh: 'not-a-timestamp' }],
    ['invalid calendar timestamp', { last_refresh: `${new Date(nowMs).getUTCFullYear()}-02-30T00:00:00Z` }],
    ['invalid hour timestamp', { last_refresh: `${new Date(nowMs).getUTCFullYear()}-10-31T24:00:00Z` }],
    ['different auth mode', { auth_mode: 'chatgptAuthTokens' }],
    ['API key auth', { OPENAI_API_KEY: 'synthetic-key' }],
  ])('rejects %s before any native spawn', (_label, patch: any) => {
    const input = source();
    expect(() => nativeConciergeAuth(JSON.stringify({ ...input, ...patch,
      tokens: { ...input.tokens, ...patch.tokens } }), { nowMs })).toThrow('darwin_broker_subscription_auth_unavailable');
  });
});
