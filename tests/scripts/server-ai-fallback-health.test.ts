import { describe, expect, it, vi } from 'vitest';
import { checkServerAiFallbacks } from '../../scripts/check-server-ai-fallbacks.mjs';
const env = { GROQ_API_KEY: 'test-only-key' };
const catalog = (models: any[]) => new Response(JSON.stringify({ data: models }));
describe('Functions fallback retirement monitoring', () => {
  it('checks the exact deployed model ids without exposing the credential', async () => {
    const fetchImpl = vi.fn(async () => catalog([{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }]));
    const result = await checkServerAiFallbacks({ env, fetchImpl });
    expect(result).toEqual({ ok: true, providers: [{ provider: 'GROQ_API_KEY', status: 'available', missingModels: [] }] });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer test-only-key' } }));
    expect(JSON.stringify(result)).not.toContain(env.GROQ_API_KEY);
  });
  it('detects a removed model even when the rest of the AI fleet is healthy', async () => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => catalog([{ id: 'openai/gpt-oss-120b' }]) });
    expect(result).toMatchObject({ ok: false, providers: [{ status: 'retired_or_unavailable', missingModels: ['openai/gpt-oss-20b'] }] });
  });
  it('does not accept lookalikes or explicitly inactive models', async () => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => catalog([{ id: 'openai/gpt-oss-safeguard-20b' }, { id: 'openai/gpt-oss-120b', active: false }]) });
    expect(result.ok).toBe(false);
    expect(result.providers[0].missingModels).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });
  it.each([401, 429, 503])('keeps HTTP %s distinct from a successful catalog check', async status => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => new Response('', { status }) });
    expect(result).toMatchObject({ ok: false, providers: [{ status: `http_${status}` }] });
  });
  it('skips an unconfigured optional fallback without a network call', async () => {
    const fetchImpl = vi.fn();
    expect(await checkServerAiFallbacks({ env: {}, fetchImpl })).toMatchObject({ ok: true, providers: [{ status: 'not_configured' }] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not treat malformed or failed catalog reads as verification', async () => {
    expect((await checkServerAiFallbacks({ env, fetchImpl: async () => new Response('{}') })).ok).toBe(false);
    expect((await checkServerAiFallbacks({ env, fetchImpl: async () => { throw new Error('network'); } })).ok).toBe(false);
  });
});
