import { describe, expect, it, vi } from 'vitest';
import { FETCH_DIAGNOSTIC_BINDING, FETCH_DIAGNOSTIC_CONTROL, installFetchDiagnostics } from '../scripts/assisted-application/lib/portal/diagnostic-fetch.mjs';

function response(body: string, headers: Record<string, string> = {}) {
  const value = new Response(body, { headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(value, 'url', { value: 'https://jobs.example/graphql?token=private' });
  return value;
}

function fixture(next: () => Promise<Response>) {
  const report = vi.fn(async (_entry: unknown) => {});
  const target = { fetch: vi.fn(next), [FETCH_DIAGNOSTIC_BINDING]: report };
  installFetchDiagnostics(target);
  const control = Reflect.get(target, FETCH_DIAGNOSTIC_CONTROL) as { reset: () => void; finish: () => Promise<void> };
  return { target, report, control };
}

describe('streamed portal fetch diagnostics', () => {
  it('reads a chunked HTTP 200 error while preserving the original promise and body', async () => {
    const body = JSON.stringify({ data: { password: 'private' }, errors: [{ code: 'INVALID_URL', message: 'Invalid profile token=private' }] });
    const original = response(body);
    const promise = Promise.resolve(original);
    const { target, report, control } = fixture(() => promise);
    expect(target.fetch()).toBe(promise);
    expect(await (await promise).text()).toBe(body);
    await control.finish();
    expect(report).toHaveBeenCalledWith({
      location: { host: 'jobs.example', path: '/graphql' }, method: 'GET', status: 200,
      errors: [{ code: 'INVALID_URL', message: 'Invalid profile token=[redacted]' }],
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  });

  it('stops at the byte limit without consuming the portal body', async () => {
    const body = JSON.stringify({ errors: [{ message: 'x'.repeat(70_000) }] });
    const original = response(body);
    const { target, report, control } = fixture(async () => original);
    expect(await (await target.fetch()).text()).toBe(body);
    await control.finish();
    expect(report).not.toHaveBeenCalled();
  });

  it('leaves bounded declared responses to the Playwright observer', async () => {
    const body = JSON.stringify({ errors: [{ message: 'Invalid URL' }] });
    const original = response(body, { 'content-length': String(body.length) });
    const clone = vi.spyOn(original, 'clone');
    const { target, report, control } = fixture(async () => original);
    await target.fetch();
    await control.finish();
    expect(clone).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('does not report successful credentials or change fetch failures', async () => {
    const original = response(JSON.stringify({ code: 'opaque-credential', message: 'Welcome', data: { token: 'private' } }));
    const good = fixture(async () => original);
    await (await good.target.fetch()).text();
    await good.control.finish();
    expect(good.report).not.toHaveBeenCalled();
    const error = new TypeError('Failed to fetch');
    const promise = Promise.reject(error);
    const failed = fixture(() => promise);
    expect(failed.target.fetch()).toBe(promise);
    await expect(promise).rejects.toBe(error);
    await failed.control.finish();
    expect(failed.report).not.toHaveBeenCalled();
  });

  it('bounds early reads and resets the budget before submit', async () => {
    const { target, report, control } = fixture(async () => response(JSON.stringify({ errors: [{ code: 'INVALID_URL' }] })));
    for (let i = 0; i < 15; i += 1) await (await target.fetch()).text();
    control.reset();
    await (await target.fetch()).text();
    await control.finish();
    expect(report).toHaveBeenCalledTimes(13);
    await (await target.fetch()).text();
    expect(report).toHaveBeenCalledTimes(13);
  });

  it('finishes within its deadline and ignores a response that completes later', async () => {
    vi.useFakeTimers();
    try {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const original = new Response(stream, { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(original, 'url', { value: 'https://jobs.example/graphql' });
      const { target, report, control } = fixture(async () => original);
      await target.fetch();
      const finish = control.finish();
      await vi.advanceTimersByTimeAsync(2001);
      await finish;
      controller?.enqueue(new TextEncoder().encode(JSON.stringify({ errors: [{ code: 'LATE_ERROR' }] })));
      controller?.close();
      await original.text();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
