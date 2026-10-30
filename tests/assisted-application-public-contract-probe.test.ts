import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { publicContractGet } from '../scripts/assisted-application/lib/portal/public-contract-get.mjs';
import { readOnlyPortalContracts } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';

const url = 'https://jobs.example.com/apply/';
const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
function transport(responses: Array<{ status?: number; headers?: object; body?: string }>) {
  const requests: any[] = [];
  const request = (target: URL, options: any, callback: any) => {
    const req: any = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const spec = responses.shift() || {};
      const response: any = Readable.from([Buffer.from(spec.body || 'public')]);
      response.statusCode = spec.status || 200;
      response.headers = spec.headers || {};
      callback(response);
    });
    req.destroy = (error: Error) => req.emit('error', error);
    requests.push({ target, options });
    return req;
  };
  return { request, requests };
}

describe('public contract transport', () => {
  it('pins the validated address while keeping TLS bound to the original hostname', async () => {
    const fixture = transport([{}]);
    const result = await publicContractGet(url, { resolve, requestImpl: fixture.request });
    expect(result.status).toBe(200);
    const options = fixture.requests[0].options;
    expect(options).toMatchObject({ method: 'GET', agent: false, servername: 'jobs.example.com' });
    const found = vi.fn();
    options.lookup('jobs.example.com', {}, found);
    expect(found).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    options.lookup('jobs.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a redirect that resolves to a private address before opening its connection', async () => {
    const fixture = transport([{ status: 302, headers: { location: 'https://private.example.com/' } }]);
    const dns = vi.fn(async (host: string) => [{ address: host.startsWith('private') ? '127.0.0.1' : '93.184.216.34', family: 4 }]);
    await expect(publicContractGet(url, { resolve: dns, requestImpl: fixture.request })).rejects.toThrow('contract_dns_unsafe');
    expect(fixture.requests).toHaveLength(1);
  });

  it('rejects mixed public/private DNS results and credentials without a connection', async () => {
    const fixture = transport([]);
    await expect(publicContractGet(url, { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], requestImpl: fixture.request })).rejects.toThrow('contract_dns_unsafe');
    await expect(publicContractGet('https://user:password@jobs.example.com/', { resolve, requestImpl: fixture.request })).rejects.toThrow('contract_url_unsafe');
    expect(fixture.requests).toHaveLength(0);
  });

  it('fails closed on byte overflow, including a cumulative caller budget', async () => {
    const fixture = transport([{ body: '123456' }]);
    await expect(publicContractGet(url, { resolve, requestImpl: fixture.request, maxBytes: 3 })).rejects.toThrow('contract_response_too_large');
    const cumulative = transport([{ body: '123456' }]);
    await expect(publicContractGet(url, { resolve, requestImpl: cumulative.request, onBytes: () => { throw new Error('global_budget'); } })).rejects.toThrow('global_budget');
  });
});

function browserFixture(requests: any[]) {
  let routeHandler: any;
  const aborts: any[] = [];
  const page: any = {
    mainFrame: () => page,
    goto: async () => {
      for (const request of requests) await routeHandler({ request: () => request, abort: async () => { aborts.push(request); } });
    },
    waitForLoadState: async () => {},
    url: () => url,
  };
  const context = {
    route: async (_pattern: string, handler: any) => { routeHandler = handler; },
    routeWebSocket: vi.fn(async () => {}), exposeBinding: vi.fn(async () => {}), addInitScript: vi.fn(async () => {}),
    newPage: async () => page, close: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  return { browser, context, aborts };
}

describe('read-only browser boundary', () => {
  it.each(['application/json', 'application/x-www-form-urlencoded'])('does not read, parse or retain blocked bodies: %s', contentType => {
    return (async () => {
      const sentinel = 'PRIVATE_SENTINEL_NOT_FOR_PROOF';
      const body = vi.fn(() => `{"token":"${sentinel}","large":"${'x'.repeat(5000)}"}`);
      const request = {
        method: () => 'POST', isNavigationRequest: () => false, resourceType: () => 'xhr',
        url: () => contentType === 'application/json' ? `${url}timezone/?secret=${sentinel}` : `data:application/json,{"token":"${sentinel}"}`,
        headers: vi.fn(() => ({ 'content-type': contentType, 'content-length': '999999999' })), postData: body, postDataBuffer: body,
      };
      const fixture = browserFixture(Array.from({ length: 10 }, () => request));
      const result = await readOnlyPortalContracts({ applyUrl: url, job: {}, launch: async () => fixture.browser,
        get: async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }) });
      expect(result.complete).toBe(false);
      expect(fixture.aborts).toHaveLength(10);
      expect(body).not.toHaveBeenCalled();
      expect(request.headers).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result).length).toBeLessThan(2000);
      expect(result.deniedRequests).toHaveLength(3);
      expect(fixture.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ offline: true, serviceWorkers: 'block', acceptDownloads: false }));
      expect(fixture.context.close).toHaveBeenCalledOnce();
      expect(fixture.browser.close).toHaveBeenCalledOnce();
    })();
  });

  it('does not send arbitrary GET APIs while reading a form', async () => {
    const request = { method: () => 'GET', isNavigationRequest: () => false, resourceType: () => 'fetch', url: () => `${url}api/action/` };
    const fixture = browserFixture([request]);
    const get = vi.fn(async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }));
    expect((await readOnlyPortalContracts({ applyUrl: url, launch: async () => fixture.browser, get })).complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(fixture.aborts).toHaveLength(1);
  });
});
