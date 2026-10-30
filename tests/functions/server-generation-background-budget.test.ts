import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async (key: string) => key === 'NVIDIA_API_KEY' ? 'test-only-key' : ''),
}));
vi.mock('../../functions/src/codexFallback.js', () => ({ tryCodexFallback: vi.fn(async () => ({ ok: false, notConfigured: true })) }));
const { generateServerText, handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');
const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');
const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Native AbortSignal.timeout does not use fake timers. Model the same abort
  // contract on the virtual clock, so the test takes no real 30-second sleep.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn((_url: string, { signal }: any) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"requirements":[]}' } }] }))), 30_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input = { userPrompt: 'Synthetic full posting qualification', maxProviderAttempts: 3, allowCodexFallback: false };

describe('trusted background inference budget', () => {
  it('finishes a realistic 30s NVIDIA response in background', async () => {
    const result = generateServerText({ ...input, background: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ status: 200, body: { provider: 'nvidia-gpt-oss-20b', ok: true } });
  });
  it('keeps the 18s interactive cap, including untrusted body overrides', async () => {
    const result = handleGeminiGenerate({ method: 'POST', body: { ...input, background: true, userPrompt: 'Short interactive prompt' } });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await result).toMatchObject({ status: 502, body: { error: 'all_providers_failed' } });
    expect(tryCodexFallback).toHaveBeenCalledTimes(1);
  });
  it('cancels the last background attempt at the shared run deadline and starts no fallback', async () => {
    const controller = new AbortController();
    const result = generateServerText({ ...input, background: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort(new Error('matching deadline'));
    expect(await result).toMatchObject({ status: 503, body: { error: 'generation_cancelled' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tryCodexFallback).not.toHaveBeenCalled();
  });
  it('does not start requests or config reads after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await generateServerText({ ...input, background: true, signal: controller.signal })).toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getRemoteConfigValue).not.toHaveBeenCalled();
  });
});
