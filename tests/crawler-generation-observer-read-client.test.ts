import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubActionsReadClient,
  isMissingExactGitHubResource,
} from '../scripts/lib/github-actions-read-client.mjs';

function client(fetchImpl: typeof fetch, sleep = vi.fn()) {
  return createGitHubActionsReadClient({
    apiUrl: 'https://api.github.test',
    token: 'test-token',
    fetchImpl,
    sleep,
    timeoutMs: 1_000,
  });
}

describe('GitHub Actions read-only client', () => {
  it.each([429, 500])('retries GET %s once and never emits another method', async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(client(fetchImpl).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('retries transport/abort and 403 only when Retry-After is present', async () => {
    const transport = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'AbortError'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(client(transport).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });

    const throttled = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'Retry-After': '9' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const sleep = vi.fn();
    await expect(client(throttled, sleep).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(5_000);

    const forbidden = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(client(forbidden).json('/repos/o/r/actions/runs/1')).rejects.toThrow(/github_api_failed/);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('bounds attempts and response bytes without retrying malformed or oversized bodies', async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(client(unavailable).json('/repos/o/r/actions/runs/1')).rejects.toThrow(/github_api_failed/);
    expect(unavailable).toHaveBeenCalledTimes(3);

    const oversized = vi.fn().mockResolvedValue(new Response('x'.repeat(33), { status: 200 }));
    await expect(client(oversized).json('/repos/o/r/actions/runs/1', 32))
      .rejects.toThrow(/github_response_too_large/);
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it('follows exactly one HTTPS artifact redirect and never forwards the bearer token', async () => {
    const redirected = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://storage.test/artifact.zip?sig=1' },
      }))
      .mockResolvedValueOnce(new Response('PK', { status: 200 }));
    const body = await client(redirected).bytes('/repos/o/r/actions/artifacts/1/zip');
    expect(new TextDecoder().decode(body)).toBe('PK');
    expect(redirected).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = redirected.mock.calls[0];
    const [hopUrl, hopInit] = redirected.mock.calls[1];
    expect(firstUrl).toBe('https://api.github.test/repos/o/r/actions/artifacts/1/zip');
    expect(firstInit?.redirect).toBe('manual');
    expect(hopUrl).toBe('https://storage.test/artifact.zip?sig=1');
    expect(hopInit?.redirect).toBe('error');
    expect(hopInit?.headers).not.toHaveProperty('authorization');

    const insecure = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://storage.test/artifact.zip' },
    }));
    await expect(client(insecure).bytes('/repos/o/r/actions/artifacts/1/zip'))
      .rejects.toThrow(/github_redirect_invalid/);
    expect(insecure).toHaveBeenCalledTimes(1);
  });

  it('preserves an authoritative 404 status for bounded domain classification', async () => {
    const missing = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const error = await client(missing).json('/repos/o/r/actions/runs/1').catch((reason) => reason);
    expect(error).toMatchObject({ code: 'github_api_failed', status: 404 });
    expect(isMissingExactGitHubResource(error)).toBe(true);
    expect(missing).toHaveBeenCalledTimes(1);
  });
});

// #9729: `releaseLock()` is reader cleanup. Older WHATWG streams and polyfilled
// bodies throw from it (pending read, stream left mid-cancel); thrown from the
// `finally` it replaced the verdict and the outer catch turned a completed read
// into a retried "transport" failure. Both site copies are exercised: the
// `.github/corpus-workflows` one is the `identical` source that descends to the
// corpus as `scripts/ci/lib/github-actions-read-client.mjs`.
describe.each([
  ['scripts/lib', () => import('../scripts/lib/github-actions-read-client.mjs')],
  ['corpus-workflows observer copy', () => import('../.github/corpus-workflows/observers/scripts/lib/github-actions-read-client.mjs')],
])('releaseLock() that throws is non-fatal (%s)', (_label, load) => {
  function responseWithThrowingRelease(chunks: number[][]) {
    const queue = chunks.map((chunk) => Uint8Array.from(chunk));
    let cancelled = false;
    const reader = {
      read: async () => (queue.length
        ? { done: false, value: queue.shift() }
        : { done: true, value: undefined }),
      cancel: async () => { cancelled = true; },
      releaseLock() { throw new TypeError('Invalid state: reader released with pending read requests'); },
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader, cancel: async () => { cancelled = true; } },
    };
    return { response, wasCancelled: () => cancelled };
  }

  it('keeps a fully read body and does not retry', async () => {
    const { createGitHubActionsReadClient } = await load();
    const { response } = responseWithThrowingRelease([[123, 34, 111], [107, 34, 58, 49, 125]]);
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const readClient = createGitHubActionsReadClient({
      apiUrl: 'https://api.github.test', token: 't', fetchImpl, sleep: vi.fn(), timeoutMs: 1_000,
    });
    await expect(readClient.json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the oversize verdict (chunked, no Content-Length) and cancels the stream', async () => {
    const { createGitHubActionsReadClient } = await load();
    const { response, wasCancelled } = responseWithThrowingRelease([[1, 2, 3], [4, 5, 6]]);
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const readClient = createGitHubActionsReadClient({
      apiUrl: 'https://api.github.test', token: 't', fetchImpl, sleep: vi.fn(), timeoutMs: 1_000,
    });
    await expect(readClient.bytes('/repos/o/r/actions/runs/1', 4)).rejects.toThrow(/github_response_too_large/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wasCancelled()).toBe(true);
  });
});
