import { describe, expect, it, vi } from 'vitest';
import { registerCookieSessionRecovery } from '../scripts/assisted-application/lib/portal/cookie-session.mjs';

const session = 'synthetic-session';
const origin = 'https://jobs.example';
function response(status: number, data: any = {}) {
  return { status: () => status, text: async () => typeof data === 'string' ? data : JSON.stringify(data), dispose: vi.fn(async () => {}) };
}
async function fixture({ url = `${origin}/cookiecheck-cc0.html?sid=${session}`, frame = `${origin}/apply/`, method = 'GET',
  cookies = [{ name: 'sid', value: session }], status = 500, recoveredStatus = 200,
  body = { cookie_allowed: true, session_id: session } as any } = {}) {
  let handler: any;
  const context = { cookies: vi.fn(async () => cookies), route: vi.fn(async (_: string, fn: any) => { handler = fn; }) };
  const original = response(status);
  const recovered = response(recoveredStatus, body);
  const route = {
    request: () => ({ url: () => url, method: () => method, frame: () => ({ url: () => frame }) }),
    fetch: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(recovered),
    fulfill: vi.fn(async () => {}), fallback: vi.fn(async () => {}),
  };
  const log = vi.fn();
  await registerCookieSessionRecovery(context, { log });
  return { context, route, original, recovered, log, run: () => handler(route) };
}

describe('owned cookie-session preflight recovery', () => {
  it('recovers a server error only with the same cookie-backed session proven by the server', async () => {
    const f = await fixture(); await f.run();
    expect(f.route.fetch.mock.calls).toEqual([
      [{ maxRedirects: 0, timeout: 15000 }],
      [{ url: `${origin}/cookiecheck-cc0.html`, maxRedirects: 0, timeout: 15000 }],
    ]);
    expect(f.route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: f.recovered });
    expect(f.original.dispose).toHaveBeenCalledOnce();
    expect(f.recovered.dispose).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith('portal cookie session check recovered', 'jobs.example');
  });

  it.each([
    { method: 'POST' },
    { url: `${origin}/UPLOAD-upl0.php?sid=${session}` },
    { url: `${origin}/cookiecheck-cc0.html?sid=${session}&extra=1` },
    { url: `${origin}/cookiecheck-cc0.html?sid=other` },
    { url: `${origin}/cookiecheck-cc0.html?sid=` },
    { frame: 'https://other.example/apply/' },
    { cookies: [] },
    { cookies: [{ name: 'sid', value: session }, { name: 'sid', value: session }] },
  ])('keeps unsupported or ambiguous requests on their normal route: %j', async options => {
    const f = await fixture(options); await f.run();
    expect(f.route.fallback).toHaveBeenCalledOnce();
    expect(f.route.fetch).not.toHaveBeenCalled();
    expect(f.route.fulfill).not.toHaveBeenCalled();
  });

  it.each([200, 302, 400, 401, 403, 429])('preserves status %s without a recovery request', async status => {
    const f = await fixture({ status }); await f.run();
    expect(f.route.fetch).toHaveBeenCalledTimes(1);
    expect(f.route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: f.original });
  });

  it.each([
    { body: { cookie_allowed: false, session_id: session } },
    { body: { cookie_allowed: true, session_id: 'different' } },
    { body: { cookie_allowed: true } },
    { body: 'invalid json' },
    { body: ' '.repeat(4097) },
    { recoveredStatus: 500 },
    { recoveredStatus: 302 },
  ])('preserves the actual server failure when the canonical response cannot prove the session: %j', async options => {
    const f = await fixture(options); await f.run();
    expect(f.route.fetch).toHaveBeenCalledTimes(2);
    expect(f.route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: f.original });
    expect(f.log).not.toHaveBeenCalled();
  });

  it('falls back without replaying a failed upload or final application when the preflight transport fails', async () => {
    const f = await fixture(); f.route.fetch.mockReset().mockRejectedValue(new Error('connection failed'));
    await f.run();
    expect(f.route.fallback).toHaveBeenCalledOnce();
    expect(f.route.fetch).toHaveBeenCalledTimes(1);
    expect(f.route.fulfill).not.toHaveBeenCalled();
  });

  it('cannot fulfill twice when the optional logger fails', async () => {
    const f = await fixture(); f.log.mockImplementation(() => { throw new Error('logger unavailable'); });
    await f.run();
    expect(f.route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: f.recovered });
  });
});
