import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
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

  it('keeps a copy of every chunk when the reader reuses its buffer (#7483)', async () => {
    const { createGitHubActionsReadClient } = await load();
    const reused = new Uint8Array(4);
    const parts = ['{"ok', '":1}'].map((part) => new TextEncoder().encode(part));
    const reader = {
      read: async () => {
        const part = parts.shift();
        if (!part) return { done: true, value: undefined };
        reused.set(part);
        return { done: false, value: reused };
      },
      cancel: async () => {},
      releaseLock() {},
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader, cancel: async () => {} },
    };
    const readClient = createGitHubActionsReadClient({
      apiUrl: 'https://api.github.test', token: 't', fetchImpl: vi.fn().mockResolvedValue(response), sleep: vi.fn(), timeoutMs: 1_000,
    });
    // Kept by reference, the body read back as '":1}":1}'.
    await expect(readClient.json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: 1 });
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

  // FU-2026-09-29-005: the cap is inclusive. A body of exactly maxBytes is
  // read whole; one byte more is the oversize verdict. The reader lock is
  // released on both paths, and only the oversize one cancels the stream.
  function trackedResponse(chunks: Array<ArrayBuffer | ArrayBufferView>) {
    const queue = [...chunks];
    const calls = { cancelled: 0, released: 0 };
    const reader = {
      read: async () => (queue.length
        ? { done: false, value: queue.shift() }
        : { done: true, value: undefined }),
      cancel: async () => { calls.cancelled += 1; },
      releaseLock() { calls.released += 1; },
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader, cancel: async () => { calls.cancelled += 1; } },
    };
    return { response, calls };
  }

  async function readWith(load: () => Promise<any>, response: unknown, maxBytes: number) {
    const { createGitHubActionsReadClient } = await load();
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const readClient = createGitHubActionsReadClient({
      apiUrl: 'https://api.github.test', token: 't', fetchImpl, sleep: vi.fn(), timeoutMs: 1_000,
    });
    return { result: readClient.bytes('/repos/o/r/actions/runs/1', maxBytes), fetchImpl };
  }

  it('reads a body of exactly maxBytes whole and releases the reader', async () => {
    const { response, calls } = trackedResponse([Uint8Array.from([1, 2]), Uint8Array.from([3, 4])]);
    const { result, fetchImpl } = await readWith(load, response, 4);
    expect(Array.from(await result)).toEqual([1, 2, 3, 4]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ cancelled: 0, released: 1 });
  });

  it('rejects maxBytes + 1 as oversize, cancels and releases the reader', async () => {
    const { response, calls } = trackedResponse([Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])]);
    const { result, fetchImpl } = await readWith(load, response, 4);
    await expect(result).rejects.toThrow(/github_response_too_large/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ cancelled: 1, released: 1 });
  });

  // FU-2026-09-29-004: over a bare ArrayBuffer `new Uint8Array(value)` is a
  // view, not a copy, so a producer that reuses its buffer rewrote bytes the
  // client had already read: [1,2][3,4] came back as [3,4,3,4].
  it('copies a bare ArrayBuffer chunk the producer later rewrites', async () => {
    const shared = new ArrayBuffer(2);
    const parts = [[1, 2], [3, 4]];
    const reader = {
      read: async () => {
        const part = parts.shift();
        if (!part) return { done: true, value: undefined };
        new Uint8Array(shared).set(part);
        return { done: false, value: shared };
      },
      cancel: async () => {},
      releaseLock() {},
    };
    const response = {
      ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader, cancel: async () => {} },
    };
    const { result } = await readWith(load, response, 4);
    const bytes = await result;
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    new Uint8Array(shared).set([9, 9]);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  // FU-2026-10-05-001: `instanceof ArrayBuffer` is false across realms, but
  // a polyfilled reader can still hand the observer a real cross-realm buffer.
  it('copies a cross-realm ArrayBuffer chunk the producer later rewrites', async () => {
    const shared = runInNewContext('new ArrayBuffer(2)') as ArrayBuffer;
    const parts = [[1, 2], [3, 4]];
    const reader = {
      read: async () => {
        const part = parts.shift();
        if (!part) return { done: true, value: undefined };
        new Uint8Array(shared).set(part);
        return { done: false, value: shared };
      },
      cancel: async () => {},
      releaseLock() {},
    };
    const response = {
      ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader, cancel: async () => {} },
    };
    const { result } = await readWith(load, response, 4);
    const bytes = await result;
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    new Uint8Array(shared).set([9, 9]);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('copies the bytes of a non-Uint8 view, not its elements', async () => {
    const backing = Uint8Array.from([0xff, 1, 2, 3, 4, 0xff]);
    const { response } = trackedResponse([new DataView(backing.buffer, 1, 4)]);
    const { result } = await readWith(load, response, 4);
    expect(Array.from(await result)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a chunk that is not bytes without retrying it', async () => {
    const { response, calls } = trackedResponse(['{"ok":1}' as unknown as ArrayBufferView]);
    const { result, fetchImpl } = await readWith(load, response, 64);
    await expect(result).rejects.toThrow(/github_api_invalid/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls.released).toBe(1);
  });
});
