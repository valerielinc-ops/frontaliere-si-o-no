/**
 * #9729, the sibling class of the event-image fix.
 *
 * 1. A Content-Length pre-check followed by `response.text()` or
 *    `arrayBuffer()` is not a cap: a chunked response without Content-Length
 *    is downloaded in full before its size is compared. The shared reader
 *    `scripts/lib/bounded-response-body.mjs` applies the cap while the body
 *    streams, and the consumers that had the post-hoc check now use it (or an
 *    inline copy for the standalone translate successor guard). The verdict
 *    was already "too large" before the fix; what changes is how much of the
 *    body is pulled, so the assertions count pulled chunks.
 * 2. `releaseLock()` in the reader cleanup must not replace the verdict. The
 *    two bounded GitHub readers not covered by
 *    `tests/crawler-generation-observer-read-client.test.ts` are exercised
 *    with a reader whose `releaseLock()` throws.
 * 3. #7483: every chunk is copied, because a reader may hand back the same
 *    buffer on every read (corpus nanakokyobashi-rgb/frontaliere-articles#1906
 *    on the event-image twin).
 *
 * Synthetic streams only: no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseBytes } from '../../scripts/lib/bounded-response-body.mjs';
import { fetchScheduledRuns } from '../../scripts/ci/orchestrator-heartbeat.mjs';
import { verifyRecoverySuccessor } from '../../scripts/ci/translate-recovery-successor-guard.mjs';
import { fetchVerifiedLogo, MAX_LOGO_BODY_BYTES } from '../../scripts/lib/company-logo-audit.mjs';
import { readBoundedJsonResponse } from '../../scripts/lib/githubWorkflowDispatch.mjs';
import { createGitHubActionsRequester } from '../../scripts/crawler-generation-dispatch.mjs';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Chunked body (no Content-Length) that counts how many chunks were pulled. */
function countingStream(totalChunks: number, chunkBytes: number) {
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= totalChunks) {
        controller.close();
        return;
      }
      stats.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

/** Response-like object whose reader throws from releaseLock(). */
function responseWithThrowingRelease(chunks: Uint8Array[], headers = new Headers()) {
  const queue = [...chunks];
  const state = { cancelled: false, released: 0 };
  const reader = {
    read: async () => (queue.length
      ? { done: false, value: queue.shift() }
      : { done: true, value: undefined }),
    cancel: async () => { state.cancelled = true; },
    releaseLock() {
      state.released += 1;
      throw new TypeError('Invalid state: reader released with pending read requests');
    },
  };
  const response = {
    ok: true,
    status: 200,
    headers,
    body: { getReader: () => reader, cancel: async () => { state.cancelled = true; } },
  };
  return { response, state };
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * Response-like object whose reader hands back the SAME Uint8Array on every
 * read, rewritten with the next slice of `text` (padded with JSON whitespace to
 * equal parts). A reader that keeps the chunk by reference ends up with the
 * last slice repeated `parts` times.
 */
function responseReusingBuffer(text: string, parts = 2, { bare = false } = {}) {
  const encoded = new TextEncoder().encode(text);
  const partBytes = Math.ceil(encoded.byteLength / parts);
  const padded = new Uint8Array(partBytes * parts).fill(0x20);
  padded.set(encoded);
  const reused = new Uint8Array(partBytes);
  let next = 0;
  const reader = {
    read: async () => {
      if (next === parts) return { done: true, value: undefined };
      reused.set(padded.subarray(next * partBytes, (next + 1) * partBytes));
      next += 1;
      // `bare`: a polyfilled body handing back the bare ArrayBuffer, over
      // which `new Uint8Array(value)` / `Buffer.from(value)` are views.
      return { done: false, value: bare ? reused.buffer : reused };
    },
    cancel: async () => {},
    releaseLock() {},
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: { getReader: () => reader, cancel: async () => {} },
    reused,
  };
}

describe('readBoundedResponseBytes', () => {
  it('interrupts a chunked response without Content-Length as soon as it crosses the cap', async () => {
    const { stream, stats } = countingStream(64, 256 * KIB);
    const result = await readBoundedResponseBytes(new Response(stream), MIB);
    expect(result).toBeNull();
    expect(stats.cancelled).toBe(true);
    // 4 chunks fill the cap, the 5th crosses it; a full read would pull all 64.
    expect(stats.pulled).toBeLessThanOrEqual(6);
  });

  it('returns the exact bytes of a chunked response under the cap', async () => {
    const { stream, stats } = countingStream(3, 100);
    const result = await readBoundedResponseBytes(new Response(stream), 1_000);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result?.byteLength).toBe(300);
    expect(stats.pulled).toBe(3);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const { stream } = countingStream(4, 256);
    const result = await readBoundedResponseBytes(new Response(stream), 1_024);
    expect(result?.byteLength).toBe(1_024);
  });

  it('rejects a declared Content-Length over the cap without reading the body', async () => {
    const { stream, stats } = countingStream(64, 256 * KIB);
    const response = new Response(stream, { headers: { 'content-length': String(16 * MIB) } });
    expect(await readBoundedResponseBytes(response, MIB)).toBeNull();
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it('returns an empty array for a response without a body', async () => {
    const result = await readBoundedResponseBytes(new Response(null, { status: 204 }), 10);
    expect(result?.byteLength).toBe(0);
  });

  it('rethrows a read error after cancelling the body', async () => {
    const cancel = vi.fn(async () => {});
    const response = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => { throw new Error('socket hang up'); },
          cancel,
          releaseLock() {},
        }),
      },
    };
    await expect(readBoundedResponseBytes(response, 10)).rejects.toThrow('socket hang up');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not let a stalled cancel hold the caller forever', async () => {
    const response = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(20) }),
          cancel: () => new Promise(() => {}),
          releaseLock() {},
        }),
      },
    };
    const started = Date.now();
    expect(await readBoundedResponseBytes(response, 10)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a releaseLock() that throws keeps a complete read', async () => {
    const { response, state } = responseWithThrowingRelease([json({ ok: 1 })]);
    const result = await readBoundedResponseBytes(response, 1_000);
    expect(JSON.parse(new TextDecoder().decode(result!))).toEqual({ ok: 1 });
    expect(state.released).toBe(1);
  });

  it('a releaseLock() that throws keeps the oversize verdict', async () => {
    const { response, state } = responseWithThrowingRelease([new Uint8Array(8), new Uint8Array(8)]);
    expect(await readBoundedResponseBytes(response, 10)).toBeNull();
    expect(state.cancelled).toBe(true);
  });
});

describe('consumers that checked the cap only after downloading the body', () => {
  it('orchestrator heartbeat stops reading the Actions response at MAX_RESPONSE_BYTES', async () => {
    const { stream, stats } = countingStream(64, 256 * KIB);
    await expect(fetchScheduledRuns({
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })).rejects.toThrow('actions_response_too_large');
    // 2 MiB cap / 256 KiB chunks: the 9th chunk crosses it. Before: all 64.
    expect(stats.pulled).toBeLessThanOrEqual(10);
    expect(stats.cancelled).toBe(true);
  });

  it('orchestrator heartbeat still parses a normal response', async () => {
    const { runs } = await fetchScheduledRuns({
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 }),
    });
    expect(runs).toEqual([]);
  });

  it('translate successor guard stops reading a GitHub response at MAX_RESPONSE_BYTES', async () => {
    const { stream, stats } = countingStream(64, 256 * KIB);
    await expect(verifyRecoverySuccessor({
      apiUrl: 'https://api.github.com',
      token: 'test-token',
      runId: '33534757741',
      runAttempt: '2',
      headSha: 'a'.repeat(40),
      eventName: 'workflow_dispatch',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })).rejects.toThrow('successor_guard_response_too_large');
    // 4 MiB cap / 256 KiB chunks: the 17th chunk crosses it. Before: all 64.
    expect(stats.pulled).toBeLessThanOrEqual(18);
    expect(stats.cancelled).toBe(true);
  });

  it('company logo fetch stops reading at MAX_LOGO_BODY_BYTES', async () => {
    const { stream, stats } = countingStream(64, 64 * KIB);
    const result = await fetchVerifiedLogo('https://logos.example.test/a.png', {
      fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }),
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ status: 'broken', reason: 'body-too-large' });
    // 2 MiB cap / 64 KiB chunks: the 33rd chunk crosses it. Before: all 64.
    expect(MAX_LOGO_BODY_BYTES).toBe(2 * MIB);
    expect(stats.pulled).toBeLessThanOrEqual(34);
    expect(stats.cancelled).toBe(true);
  });

  it('company logo fetch reports a declared oversize body as body-too-large, unread', async () => {
    const { stream, stats } = countingStream(64, 64 * KIB);
    const result = await fetchVerifiedLogo('https://logos.example.test/a.png', {
      fetchImpl: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(4 * MIB) },
      }),
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ status: 'broken', reason: 'body-too-large' });
    expect(stats.pulled).toBe(0);
  });
});

describe('releaseLock() that throws in the other bounded GitHub readers', () => {
  it('githubWorkflowDispatch keeps a fully read body', async () => {
    const { response } = responseWithThrowingRelease([json({ workflow_run_id: 1 })]);
    await expect(readBoundedJsonResponse(response, 1_000)).resolves.toEqual({ workflow_run_id: 1 });
  });

  it('githubWorkflowDispatch keeps the oversize verdict', async () => {
    const { response, state } = responseWithThrowingRelease([new Uint8Array(8), new Uint8Array(8)]);
    await expect(readBoundedJsonResponse(response, 10)).rejects.toThrow('github_response_too_large');
    expect(state.cancelled).toBe(true);
  });

  it('crawler-generation-dispatch keeps a fully read body', async () => {
    const { response } = responseWithThrowingRelease([json({ ok: 1 })]);
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 't',
      fetchImpl: async () => response,
    });
    await expect(request({ method: 'GET', path: '/repos/o/r/actions/runs/1' }))
      .resolves.toMatchObject({ status: 200, body: { ok: 1 } });
  });

  it('crawler-generation-dispatch keeps the oversize verdict', async () => {
    const { response, state } = responseWithThrowingRelease([new Uint8Array(MIB), new Uint8Array(1)]);
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 't',
      fetchImpl: async () => response,
    });
    await expect(request({ method: 'GET', path: '/repos/o/r/actions/runs/1' }))
      .rejects.toThrow('response_too_large');
    expect(state.cancelled).toBe(true);
  });
});

// #7483, the sibling class of corpus nanakokyobashi-rgb/frontaliere-articles#1906:
// a reader may reuse its buffer, so a reader that keeps each chunk by reference
// (or as a view over `value.buffer`) returns the last chunk repeated.
describe('bounded readers keep a copy of every chunk when the reader reuses its buffer', () => {
  it('readBoundedResponseBytes returns the bytes in order', async () => {
    const result = await readBoundedResponseBytes(responseReusingBuffer('abcd'), 1_000);
    expect(new TextDecoder().decode(result!)).toBe('abcd');
  });

  it('readBoundedResponseBytes does not return the reader buffer for a single chunk', async () => {
    const response = responseReusingBuffer('ab', 1);
    const result = await readBoundedResponseBytes(response, 1_000);
    response.reused.set([0x78, 0x78]);
    expect(new TextDecoder().decode(result!)).toBe('ab');
  });

  it('githubWorkflowDispatch parses the whole body', async () => {
    const response = responseReusingBuffer(JSON.stringify({ workflow_run_id: 12 }));
    await expect(readBoundedJsonResponse(response, 1_000)).resolves.toEqual({ workflow_run_id: 12 });
  });

  it('crawler-generation-dispatch parses the whole body', async () => {
    const response = responseReusingBuffer(JSON.stringify({ ok: 12 }));
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 't',
      fetchImpl: async () => response,
    });
    await expect(request({ method: 'GET', path: '/repos/o/r/actions/runs/1' }))
      .resolves.toMatchObject({ status: 200, body: { ok: 12 } });
  });

  it('translate successor guard parses the workflow payload and reaches the claim lookup', async () => {
    // Read correctly, the first payload is valid and the guard asks for the
    // claim (404 here). Read as the last half twice, it fails as invalid JSON.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(responseReusingBuffer(JSON.stringify({ type: 'file', sha: 'b'.repeat(40) })))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(verifyRecoverySuccessor({
      apiUrl: 'https://api.github.com',
      token: 'test-token',
      runId: '33534757741',
      runAttempt: '2',
      headSha: 'a'.repeat(40),
      eventName: 'workflow_dispatch',
      fetchImpl,
    })).rejects.toThrow('successor_guard_claim_missing');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// Site issue 10283 (FU-2026-09-29-004): the same reuse through a bare
// ArrayBuffer. `new Uint8Array(value)` and `Buffer.from(value)` copy a
// Uint8Array but only VIEW an ArrayBuffer, so the #7483 copy did not hold.
describe('bounded readers copy a bare ArrayBuffer chunk the reader reuses', () => {
  it('githubWorkflowDispatch parses the whole body', async () => {
    const response = responseReusingBuffer(JSON.stringify({ workflow_run_id: 12 }), 2, { bare: true });
    await expect(readBoundedJsonResponse(response, 1_000)).resolves.toEqual({ workflow_run_id: 12 });
  });

  it('crawler-generation-dispatch parses the whole body', async () => {
    const response = responseReusingBuffer(JSON.stringify({ ok: 12 }), 2, { bare: true });
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 't',
      fetchImpl: async () => response,
    });
    await expect(request({ method: 'GET', path: '/repos/o/r/actions/runs/1' }))
      .resolves.toMatchObject({ status: 200, body: { ok: 12 } });
  });
});
