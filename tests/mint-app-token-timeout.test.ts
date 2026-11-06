import { describe, expect, it } from 'vitest';
import { ghJson } from '../scripts/ci/mint-app-token.mjs';

describe('ghJson — deadline bounded per il control plane App', () => {
  it('abortisce una richiesta GitHub che non riceve risposta entro la deadline', async () => {
    let signal: AbortSignal | undefined;
    const pendingFetch = (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<never>(() => {});
    };

    const request = ghJson('/app/installations', { fetchImpl: pendingFetch, timeoutMs: 10 });
    await expect(request).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'MINT_APP_TOKEN_TIMEOUT',
    });
    await expect(request).rejects.toThrow('GitHub API GET /app/installations timed out after 10ms');
    expect(signal?.aborted).toBe(true);
  });

  it('applica la stessa deadline alla lettura del body', async () => {
    let signal: AbortSignal | undefined;
    const stalledBodyFetch = (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return Promise.resolve({
        status: 201,
        json: () => new Promise<never>(() => {}),
      });
    };

    await expect(
      ghJson('/app/installations/1/access_tokens', {
        method: 'POST',
        fetchImpl: stalledBodyFetch,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'MINT_APP_TOKEN_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });

  it('conserva il body nullo quando GitHub restituisce JSON non valido', async () => {
    const result = await ghJson('/app/installations', {
      fetchImpl: () => Promise.resolve({
        status: 502,
        json: () => Promise.reject(new SyntaxError('invalid json')),
      }),
      timeoutMs: 100,
    });
    expect(result).toEqual({ status: 502, body: null });
  });
});
