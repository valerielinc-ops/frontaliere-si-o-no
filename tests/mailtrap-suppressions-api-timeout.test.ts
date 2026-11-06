import { afterEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../scripts/lib/mailtrapSuppressionsApi.mjs';

async function loadApi(timeoutMs: number) {
  process.env.MAILTRAP_SUPPRESSION_API_TIMEOUT_MS = String(timeoutMs);
  return import(`${MODULE_PATH}?timeout-test=${timeoutMs}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  delete process.env.MAILTRAP_SUPPRESSION_API_TIMEOUT_MS;
  vi.unstubAllGlobals();
});

describe('Mailtrap suppression API deadlines', () => {
  it('passes a deadline signal to account, lookup, and delete requests', async () => {
    const api = await loadApi(1_000);
    const fetchSpy = vi.fn(async (_url: string, init: { signal?: AbortSignal; method?: string }) => ({
      ok: true,
      status: 200,
      json: async () => (init.method === 'DELETE' ? {} : [{ id: 'suppression-1', created_at: '2026-10-25T00:00:00Z' }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(api.fetchMailtrapAccountId('token')).resolves.toBe('suppression-1');
    await expect(api.findSuppression('token', 'account-1', 'person@example.com')).resolves.toMatchObject({ id: 'suppression-1' });
    await expect(api.deleteSuppression('token', 'account-1', 'suppression-1')).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('rejects a request that never produces a response within the deadline', async () => {
    const api = await loadApi(10);
    const fetchSpy = vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      if (!init.signal) throw new Error('missing request deadline');
      init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(api.fetchMailtrapAccountId('token')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
