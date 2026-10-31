import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';
import { publicContractGet, publicContractConsentGeoGet } from '../scripts/assisted-application/lib/portal/public-contract-get.mjs';
import { readOnlyPortalContracts, PUBLIC_CONTRACT_BYTE_BUDGET } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';

const browserLauncher = vi.hoisted(() => ({
  launch: vi.fn(async (_options: any) => { throw new Error('Executable does not exist'); }),
  installingLaunch: vi.fn(async () => { throw new Error('installer must not run'); }),
}));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({
  getChromium: async () => ({ launch: browserLauncher.launch }),
  launchChromium: browserLauncher.installingLaunch,
}));

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

it('returns unknown promptly when the prepared browser is missing, without starting an installer', async () => {
  const result = await readOnlyPortalContracts({ applyUrl: url, timeoutMs: 100,
    get: async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form></form>') }) });
  expect(result).toMatchObject({ complete: false, reason: 'transient_probe_failure' });
  expect(browserLauncher.launch).toHaveBeenCalledWith({ headless: true, timeout: expect.any(Number) });
  expect(browserLauncher.launch.mock.calls.at(-1)?.[0].timeout).toBeLessThanOrEqual(100);
  expect(browserLauncher.installingLaunch).not.toHaveBeenCalled();
});

it('gives browser launch only the deadline left after the primary GET', async () => {
  browserLauncher.launch.mockClear();
  await readOnlyPortalContracts({ applyUrl: url, timeoutMs: 200,
    get: async () => {
      await new Promise(resolve => setTimeout(resolve, 35));
      return { status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form></form>') };
    } });
  const options = browserLauncher.launch.mock.calls.at(-1)?.[0];
  expect(options.timeout).toBeGreaterThan(0);
  expect(options.timeout).toBeLessThanOrEqual(170);
  expect(browserLauncher.installingLaunch).not.toHaveBeenCalled();
});

describe('public contract transport', () => {
  it('reconstructs the official public geo Accept header only for its exact named GET', async () => {
    const fixture = transport([{ headers: { 'content-type': 'application/json' }, body: '{}' }]);
    const target = 'https://geolocation.onetrust.com/cookieconsentpub/v1/geo/location';
    await publicContractConsentGeoGet(target, { resolve, requestImpl: fixture.request, cookieHeader: 'must_not_forward=secret' });
    expect(fixture.requests[0].options).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
    expect(fixture.requests[0].options.headers).not.toHaveProperty('Cookie');
    expect(fixture.requests[0].options.headers).not.toHaveProperty('Authorization');
    await expect(publicContractConsentGeoGet(target+'?private=1', { resolve, requestImpl: fixture.request })).rejects.toThrow('contract_consent_geo_invalid');
    expect(fixture.requests).toHaveLength(1);
    const plain = transport([{}]);
    await publicContractGet(url, { resolve, requestImpl: plain.request, acceptJson: true });
    expect(plain.requests[0].options.headers).not.toHaveProperty('Accept');
  });

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

  it('does not issue a second GET for an exact bootstrap asset redirect', async () => {
    const fixture = transport([{ status: 302, headers: { location: 'https://public.example.com/action?save=1' } }]);
    await expect(publicContractGet(url, { resolve, requestImpl: fixture.request, followRedirects: false })).rejects.toThrow('contract_redirect_not_allowed');
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
      for (const request of requests) await routeHandler({ request: () => request, abort: async () => { aborts.push(request); }, fulfill: async () => {} });
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
  return { browser, context, aborts, page,
    dispatch: async (request: any) => routeHandler({ request: () => request, abort: async () => { aborts.push(request); }, fulfill: async () => {} }) };
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

  it('canonicalizes a root apply URL before requesting or comparing the public document', async () => {
    const canonical = 'https://jobs.example.com/';
    const get = vi.fn(async (_url: string) => ({ status: 200, url: canonical, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form></form>') }));
    const result = await readOnlyPortalContracts({ applyUrl: 'https://jobs.example.com', get, timeoutMs: 100 });
    expect(get.mock.calls[0][0]).toBe(canonical);
    expect(result.reason).not.toBe('redirected_form_unknown');
  });

  it('does not treat an arbitrary .js GET as an attested public asset', async () => {
    const request = { method: () => 'GET', isNavigationRequest: () => false, resourceType: () => 'script', url: () => 'https://other.example.com/action.js' };
    const fixture = browserFixture([request]);
    const get = vi.fn(async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }));
    expect((await readOnlyPortalContracts({ applyUrl: url, launch: async () => fixture.browser, get })).complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(fixture.aborts).toHaveLength(1);
  });

  it('does not send arbitrary GET APIs while reading a form', async () => {
    const request = { method: () => 'GET', isNavigationRequest: () => false, resourceType: () => 'fetch', url: () => `${url}api/action/` };
    const fixture = browserFixture([request]);
    const get = vi.fn(async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }));
    expect((await readOnlyPortalContracts({ applyUrl: url, launch: async () => fixture.browser, get })).complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(fixture.aborts).toHaveLength(1);
  });

  it.each(['read', 'close', 'late_marker', 'fingerprint_drift', 'marker_drift'])('does not return a complete proof when a blocked request arrives during the final %s', async when => {
    const fixture = browserFixture([]);
    let snapshotReads = 0;
    const frame: any = { url: () => url, evaluate: async () => { snapshotReads++; return ({ url, fields: [
      { id: 'source', frame: 0, form: 0, kind: 'select', label: 'Recruitment source', required: when === 'fingerprint_drift' && snapshotReads >= 3, options: [{ label: 'Website' }] },
      { id: 'cv', frame: 0, form: 0, kind: 'file', inputType: 'file', label: 'CV', required: true },
    ], buttons: [], text: 'Example Motors', errors: [], captcha: false, passwordVisible: false }); } };
    fixture.page.frames = () => [frame];
    fixture.page.mainFrame = () => frame;
    fixture.page.evaluate = async (fn: any) => String(fn).includes('window.__portalNativeContractChanged === true') ? when === 'late_marker' : [{ id: 'source', explicitlyOptional: !(when === 'marker_drift' && snapshotReads >= 3), nativeRequired: false }];
    fixture.page.waitForTimeout = async () => {};
    const denied = { method: () => 'POST', isNavigationRequest: () => false, url: () => `${url}timezone/` };
    fixture.page.locator = () => ({ innerText: async () => {
      if (when === 'read') await fixture.dispatch(denied);
      return 'Example Motors';
    } });
    if (when === 'close') fixture.context.close.mockImplementationOnce(async () => { await fixture.dispatch(denied); });
    const result = await readOnlyPortalContracts({ applyUrl: url, job: { company: 'Example Motors' }, launch: async () => fixture.browser,
      get: async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }) });
    expect(result.complete).toBe(false);
    if (['late_marker', 'fingerprint_drift', 'marker_drift'].includes(when)) {
      expect(result.reason).toBe('native_contract_unstable');
      expect(result.nativeContractDiagnostics).toMatchObject({ phase: 'final_validation', failure: when === 'late_marker' ? 'observer_mutated' : when === 'fingerprint_drift' ? 'snapshot_fingerprint_drift' : 'snapshot_marker_drift' });
    } else expect(result.deniedRequests).toHaveLength(1);
  });
});

it.each(['cmp_cosmetic', 'employer_required', 'employer_removed', 'external_reassigned', 'external_removed'])('observes the native application form, including changes after its marker snapshot: %s', async kind => {
  const fixture = browserFixture([]);
  const nativeFields = [
    { id: 'source', frame: 0, form: 0, kind: 'select', label: 'Recruitment source', required: false, options: [{ label: 'Website' }] },
    { id: 'cv', frame: 0, form: 0, kind: 'file', inputType: 'file', label: 'CV', required: true },
  ];
  const frame: any = { url: () => url, evaluate: async () => ({ url, fields: nativeFields, buttons: [], text: 'Example Motors', errors: [], captcha: false, passwordVisible: false }) };
  const form: any = { contains: (node: any) => node === form || (!kind.startsWith('external_') && node === control) };
  const control: any = { form, getAttribute: (name: string) => name === 'data-aa-id' ? 'source' : null };
  const body: any = { contains: (node: any) => node === form };
  const cosmetic = { contains: () => false };
  const state: any = { __portalContractProbeNativeChanged: async () => {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  const MutationObserver = class {
    constructor(private callback: any) {}
    observe() {
      if (kind.startsWith('external_')) control.form = null;
      if (kind === 'employer_required') control.getAttribute = (name: string) => name === 'required' ? '' : name === 'data-aa-id' ? 'source' : null;
      this.callback([['employer_required', 'external_reassigned'].includes(kind)
      ? { type: 'attributes', target: control, attributeName: kind === 'external_reassigned' ? 'form' : 'required' }
      : { type: 'childList', target: body, addedNodes: kind === 'cmp_cosmetic' ? [cosmetic] : [], removedNodes: kind === 'employer_removed' ? [form] : kind === 'external_removed' ? [control] : [] }]); }
  };
  fixture.page.frames = () => [frame]; fixture.page.mainFrame = () => frame;
  fixture.page.waitForTimeout = async () => {};
  fixture.page.locator = () => ({ innerText: async () => 'Example Motors' });
  fixture.page.evaluate = async (fn: any, ids: any) => {
    if (String(fn).includes('new MutationObserver')) return runInNewContext(`(${fn.toString()})(ids)`, { window: state, ids, document: { querySelectorAll: () => [control], documentElement: {} }, MutationObserver });
    if (String(fn).includes('window.__portalNativeContractChanged === true')) return state.__portalNativeContractChanged;
    return [{ id: 'source', explicitlyOptional: true, nativeRequired: false }];
  };
  const proof = await readOnlyPortalContracts({ applyUrl: url, job: { company: 'Example Motors' }, launch: async () => fixture.browser,
    get: async () => ({ status: 200, url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<form>public</form>') }) });
  expect(proof.complete).toBe(kind === 'cmp_cosmetic');
  if (kind !== 'cmp_cosmetic') expect(proof.reason).toBe('native_contract_unstable');
});

it.each(['exact_remaining', 'per_asset_over', 'aggregate_over'])('bounds whole public static assets by the remaining shared 8 MiB: %s', async kind => {
  const scripts = [`${url}public-a.js`, `${url}public-b.js`];
  const html = Buffer.from(scripts.map(src => `<script src="${src}"></script>`).join(''));
  const firstBytes = kind === 'per_asset_over' ? PUBLIC_CONTRACT_BYTE_BUDGET - html.length + 1 : 5_655_402;
  const remainder = PUBLIC_CONTRACT_BYTE_BUDGET - html.length - firstBytes;
  const sizes = [firstBytes, remainder + (kind === 'aggregate_over' ? 1 : 0)];
  const requests = scripts.slice(0, kind === 'per_asset_over' ? 1 : 2).map(source => ({ method: () => 'GET', url: () => source, resourceType: () => 'script', isNavigationRequest: () => false }));
  const fixture = browserFixture(requests);
  const frame: any = { url: () => url, evaluate: async () => ({ url, fields: [
    { id: 'source', frame: 0, form: 0, kind: 'select', label: 'Recruitment source', required: false, options: [{ label: 'Website' }] },
    { id: 'cv', frame: 0, form: 0, kind: 'file', inputType: 'file', label: 'CV', required: true },
  ], buttons: [], text: 'Example Motors', errors: [], captcha: false, passwordVisible: false }) };
  fixture.page.frames = () => [frame]; fixture.page.mainFrame = () => frame;
  fixture.page.evaluate = async () => [{ id: 'source', explicitlyOptional: true, nativeRequired: false }];
  fixture.page.waitForTimeout = async () => {};
  fixture.page.locator = () => ({ innerText: async () => 'Example Motors' });
  const caps: number[] = [];
  const get = async (source: string, options: any) => {
    const index = scripts.indexOf(source);
    if (index < 0) return { url: source, status: 200, headers: { 'content-type': 'text/html' }, body: html };
    caps.push(options.maxBytes);
    return { url: source, status: 200, headers: { 'content-type': 'application/javascript' }, body: Buffer.alloc(sizes[index], ' ') };
  };
  const proof = await readOnlyPortalContracts({ applyUrl: url, job: { company: 'Example Motors' }, launch: async () => fixture.browser, get });
  expect(caps[0]).toBe(PUBLIC_CONTRACT_BYTE_BUDGET - html.length);
  if (kind !== 'per_asset_over') expect(caps[1]).toBe(remainder);
  expect(proof.complete).toBe(kind === 'exact_remaining');
  if (kind !== 'exact_remaining') expect(proof.resourceFailureCause).toBe('contract_response_too_large');
});

it('rejects concurrent static resources whose combined stream exceeds the shared 8 MiB', async () => {
  const scripts = [`${url}concurrent-a.js`, `${url}concurrent-b.js`];
  const html = Buffer.from(scripts.map(src => `<script src="${src}"></script>`).join(''));
  const requests = scripts.map(source => ({ method: () => 'GET', url: () => source, resourceType: () => 'script', isNavigationRequest: () => false }));
  const fixture = browserFixture([]);
  fixture.page.goto = async () => Promise.all(requests.map(fixture.dispatch));
  const waiting: Array<() => void> = [];
  const get = async (source: string, options: any) => {
    if (!scripts.includes(source)) return { url: source, status: 200, headers: { 'content-type': 'text/html' }, body: html };
    options.onRequest();
    await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach(release => release()); });
    options.onBytes(5 * 1024 * 1024);
    return { url: source, status: 200, headers: { 'content-type': 'application/javascript' }, body: Buffer.alloc(5 * 1024 * 1024, ' ') };
  };
  const proof = await readOnlyPortalContracts({ applyUrl: url, launch: async () => fixture.browser, get });
  expect(proof.complete).toBe(false);
  expect(proof.resourceFailureCause).toBe('contract_byte_budget');
});
