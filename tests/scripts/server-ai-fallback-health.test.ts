import { describe, expect, it, vi } from 'vitest';
import { SERVER_TEXT_FALLBACKS, serverTextFallbackBody } from '../../functions/src/serverAiFallbacks.js';
import { checkServerAiFallbacks } from '../../scripts/check-server-ai-fallbacks.mjs';
const env = { GROQ_API_KEY: 'test-only-key' };
const catalog = (models: any[]) => new Response(JSON.stringify({ data: models }));
describe('Functions fallback retirement monitoring', () => {
  it('checks the exact deployed model ids without exposing the credential', async () => {
    const fetchImpl = vi.fn(async () => catalog([{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }]));
    const result = await checkServerAiFallbacks({ env, fetchImpl });
    expect(result).toEqual({ ok: true, providers: [{ provider: 'GROQ_API_KEY', status: 'available', missingModels: [] }, { provider: 'NVIDIA_API_KEY', status: 'not_configured', missingModels: [] }] });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer test-only-key' } }));
    expect(JSON.stringify(result)).not.toContain(env.GROQ_API_KEY);
  });
  it('detects a removed model even when the rest of the AI fleet is healthy', async () => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => catalog([{ id: 'openai/gpt-oss-120b' }]) });
    expect(result.ok).toBe(false);
    expect(result.providers[0]).toMatchObject({ status: 'retired_or_unavailable', missingModels: ['openai/gpt-oss-20b'] });
  });
  it('does not accept lookalikes or explicitly inactive models', async () => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => catalog([{ id: 'openai/gpt-oss-safeguard-20b' }, { id: 'openai/gpt-oss-120b', active: false }]) });
    expect(result.ok).toBe(false);
    expect(result.providers[0].missingModels).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });
  it.each([401, 429, 503])('keeps HTTP %s distinct from a successful catalog check', async status => {
    const result = await checkServerAiFallbacks({ env, fetchImpl: async () => new Response('', { status }) });
    expect(result.ok).toBe(false);
    expect(result.providers[0]).toMatchObject({ status: `http_${status}` });
  });
  it('skips an unconfigured optional fallback without a network call', async () => {
    const fetchImpl = vi.fn();
    expect(await checkServerAiFallbacks({ env: {}, fetchImpl })).toMatchObject({ ok: true, providers: [{ provider: 'GROQ_API_KEY', status: 'not_configured' }, { provider: 'NVIDIA_API_KEY', status: 'not_configured' }] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not treat malformed or failed catalog reads as verification', async () => {
    expect((await checkServerAiFallbacks({ env, fetchImpl: async () => new Response('{}') })).ok).toBe(false);
    expect((await checkServerAiFallbacks({ env, fetchImpl: async () => { throw new Error('network'); } })).ok).toBe(false);
  });
});


it('puts an independent configured provider inside the bounded matching attempt budget', () => {
  // The primary Gemini call consumes one of the matching caller's three attempts.
  expect(SERVER_TEXT_FALLBACKS.slice(0, 2).map(provider => provider.rcKey)).toEqual(['GROQ_API_KEY', 'NVIDIA_API_KEY']);
});

it('uses each provider output-budget contract without changing the shared model', () => {
  const input = { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'test' }], maxTokens: 8192, temperature: 1.5 };
  expect(serverTextFallbackBody({ ...input, apiFamily: 'nvidia' })).toEqual({ model: input.model, messages: input.messages, max_tokens: 4096, temperature: 1, reasoning_effort: 'low' });
  expect(serverTextFallbackBody({ ...input, apiFamily: 'groq' })).toEqual({ model: input.model, messages: input.messages, max_completion_tokens: 8192, temperature: 1.5, reasoning_effort: 'low' });
});

it('verifies the independent provider catalog and reports its retirement separately', async () => {
  const fetchImpl = vi.fn(async (url: string) => catalog(url.includes('nvidia.com') ? [{ id: 'openai/gpt-oss-20b' }] : [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }]));
  const result = await checkServerAiFallbacks({ env: { ...env, NVIDIA_API_KEY: 'test-nvidia-key' }, fetchImpl });
  expect(result).toEqual({ ok: true, providers: [{ provider: 'GROQ_API_KEY', status: 'available', missingModels: [] }, { provider: 'NVIDIA_API_KEY', status: 'available', missingModels: [] }] });
  expect(fetchImpl).toHaveBeenCalledWith('https://integrate.api.nvidia.com/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer test-nvidia-key' } }));
  expect(JSON.stringify(result)).not.toContain('test-nvidia-key');
});
