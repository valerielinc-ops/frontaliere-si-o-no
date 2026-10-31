import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { rexxTimeZoneScript } from './fixtures/rexx-timezone-contract.mjs';
import { rexxTimeZoneSources, rexxTimeZoneProtocol, rexxTimeZoneBody, validRexxTimeZoneRequest, validRexxTimeZoneResponse } from '../scripts/assisted-application/lib/portal/rexx-timezone-contract.mjs';
import { publicContractTimeZoneLookup } from '../scripts/assisted-application/lib/portal/public-contract-get.mjs';
import { readOnlyPortalContracts } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';

const applyUrl = 'https://jobs.example.com/careers/application/';
const scriptUrl = 'https://jobs.example.com/assets/common.js?v=14';
const html = `<script>var base_url_rexx = 'https://jobs.example.com/careers/';</script><script src='${scriptUrl}'></script><input type='hidden' id='timezone' value=''>`;
const sources = rexxTimeZoneSources(html, applyUrl);
const protocol = rexxTimeZoneProtocol(sources, scriptUrl, Buffer.from(rexxTimeZoneScript));
const timeZone = 'Europe/Zurich';
const body = rexxTimeZoneBody(timeZone)!;
const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'content-length': String(Buffer.byteLength(body)) };
const validResponse = { status: 200, url: protocol.lookupUrl, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"success":true,"id":123}') };

describe('demonstrated REXX timezone-ID read protocol', () => {
  it('derives the endpoint only from one current DOM-owned primary script and its exact protocol AST', () => {
    expect(protocol).toMatchObject({ name: 'rexx-timezone-lookup-v1', lookupUrl: 'https://jobs.example.com/careers/timezone.html', scriptUrl });
    expect(protocol.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rexxTimeZoneProtocol(rexxTimeZoneSources(html + `<script src='${scriptUrl}'></script>`, applyUrl), scriptUrl, Buffer.from(rexxTimeZoneScript))).toBeNull();
    expect(rexxTimeZoneProtocol(sources, 'https://other.example.com/common.js', Buffer.from(rexxTimeZoneScript))).toBeNull();
    expect(rexxTimeZoneSources(html.replace('https://jobs.example.com/careers/', 'https://other.example.com/'), applyUrl)).toBeNull();
    expect(rexxTimeZoneSources(html.replace('</script>', `var base_url_rexx = 'https://jobs.example.com/';</script>`), applyUrl)).toBeNull();
  });

  it('does not attest commented, template, JSON, noscript or nomodule scripts as executable DOM ownership', () => {
    const baseConfig = `<script>var base_url_rexx = 'https://jobs.example.com/careers/';</script>`;
    for (const inert of [`<!-- <script src='${scriptUrl}'></script> -->`, `<template><script src='${scriptUrl}'></script></template>`,
      `<noscript><script src='${scriptUrl}'></script></noscript>`, `<textarea><script src='${scriptUrl}'></script></textarea>`, `<script type='application/json' src='${scriptUrl}'></script>`, `<script nomodule src='${scriptUrl}'></script>`]) {
      expect(rexxTimeZoneProtocol(rexxTimeZoneSources(baseConfig + inert, applyUrl), scriptUrl, Buffer.from(rexxTimeZoneScript))).toBeNull();
    }
  });

  it.each([
    rexxTimeZoneScript.replace("'timezone.html'", "'date.html'"),
    rexxTimeZoneScript.replace("'name': timezoneName", "'name': timezoneName, marketing: true"),
    rexxTimeZoneScript.replace('Intl.DateTimeFormat().resolvedOptions().timeZone', 'candidate.timezone'),
    rexxTimeZoneScript.replace("$('#timezone').val(response.id)", "$('#country').val(response.id)"),
    rexxTimeZoneScript + rexxTimeZoneScript,
  ])('does not infer a read exception from a nearby or ambiguous script', script => {
    expect(rexxTimeZoneProtocol(sources, scriptUrl, Buffer.from(script))).toBeNull();
  });

  it('accepts only the exact captured IANA value and single name key, never JSON or candidate inputs', () => {
    const request = { protocol, url: protocol.lookupUrl, method: 'POST', resourceType: 'xhr', mainFrame: true, timeZone, headers, body: Buffer.from(body) };
    expect(validRexxTimeZoneRequest(request)).toBe(true);
    expect(validRexxTimeZoneRequest({ ...request, headers: { 'content-type': headers['content-type'] } })).toBe(true);
    for (const changed of [
      { url: `${protocol.lookupUrl}?action=save` }, { method: 'PUT' }, { mainFrame: false }, { resourceType: 'document' },
      { body: Buffer.from(`${body}&email=PRIVATE_SENTINEL`) }, { body: Buffer.from('name=UTC') },
      { headers: { ...headers, 'content-type': 'application/json' } }, { headers: { ...headers, 'content-length': '999999999' } },
      { body: Buffer.from(`name=${'x'.repeat(1000)}`) }, { timeZone: 'private candidate text' },
    ]) expect(validRexxTimeZoneRequest({ ...request, ...changed })).toBe(false);
  });

  it('rejects unexpected response fields, redirects and unbounded/non-JSON responses', () => {
    expect(validRexxTimeZoneResponse(validResponse)).toBe(true);
    expect(validRexxTimeZoneResponse({ ...validResponse, body: Buffer.from('{"success":true,"id":"Europe/Zurich"}') })).toBe(true);
    for (const changed of [{ status: 302 }, { body: Buffer.from('{"success":true,"id":123,"marketing":true}') },
      { body: Buffer.from('{"success":false,"id":123}') }, { body: Buffer.from('{"success":true,"id":123,"id":456}') }, { body: Buffer.from(String.raw`{"success":true,"id":123,"\u0069d":456}`) }, { body: Buffer.from('{"success":true,"id":{"nested":1}}') }, { body: Buffer.from('{"success":true,"id":"<html>"}') },
      { body: Buffer.alloc(2049) }, { headers: { 'content-type': 'text/html' } }]) {
      expect(validRexxTimeZoneResponse({ ...validResponse, ...changed })).toBe(false);
    }
  });

  it('uses the same pinned socket without cookies/auth and never follows a POST redirect', async () => {
    const requests: any[] = [];
    let redirect = false;
    const requestImpl = (url: URL, options: any, callback: any) => {
      const req: any = new EventEmitter();
      req.end = (sentBody: string) => {
        requests.push({ url, options, sentBody });
        queueMicrotask(() => { const response: any = Readable.from([validResponse.body]);
          response.statusCode = redirect ? 302 : 200;
          response.headers = redirect ? { location: '/elsewhere' } : validResponse.headers; callback(response); });
      };
      return req;
    };
    const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
    expect((await publicContractTimeZoneLookup(protocol.lookupUrl, { protocol, timeZone, resolve, requestImpl })).status).toBe(200);
    expect(requests[0].sentBody).toBe(body);
    expect(requests[0].options).toMatchObject({ method: 'POST', agent: false, servername: 'jobs.example.com' });
    expect(requests[0].options.headers).not.toHaveProperty('Cookie');
    expect(requests[0].options.headers).not.toHaveProperty('Authorization');
    const callback = vi.fn(); requests[0].options.lookup('jobs.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    redirect = true;
    await expect(publicContractTimeZoneLookup(protocol.lookupUrl, { protocol, timeZone, resolve, requestImpl })).rejects.toThrow('contract_lookup_redirect');
    expect(requests).toHaveLength(2);
    await expect(publicContractTimeZoneLookup(protocol.lookupUrl, { timeZone, resolve, requestImpl })).rejects.toThrow('contract_lookup_invalid');
  });
});

function anonymousBrowserFixture({ script = rexxTimeZoneScript, extraPost = false, repeatPost = false, iframePost = false, extraBody = false, response = validResponse } = {}) {
  let route: any;
  const bindings: Record<string, any> = {};
  const requestBodies: any[] = [];
  const abort = vi.fn(async () => {});
  const fulfill = vi.fn(async () => {});
  const nativeSnapshot = { url: applyUrl, fields: [
    { id: 'source', kind: 'select', label: 'Recruitment source', required: false, options: [{ label: 'Website', value: 'web' }], form: 0 },
    { id: 'cv', kind: 'file', inputType: 'file', label: 'CV', required: true, form: 0 },
    { id: 'email', kind: 'text', inputType: 'email', label: 'Email', required: true, form: 0 },
  ], buttons: [], text: 'Example Motors', errors: [], captcha: false, passwordVisible: false };
  const frame: any = { url: () => applyUrl, evaluate: async () => nativeSnapshot };
  const page: any = { mainFrame: () => frame, frames: () => [frame], url: () => applyUrl,
    evaluate: async () => [{ id: 'source', explicitlyOptional: true, nativeRequired: false }],
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    locator: () => ({ innerText: async () => 'Example Motors' }) };
  const dispatch = async (url: string, method: string, resourceType: string, navigation = false) => {
    const postData = vi.fn(() => Buffer.from(extraBody && method === 'POST' ? `${body}&marketing=true` : body));
    const request = { url: () => url, method: () => method, resourceType: () => resourceType,
      isNavigationRequest: () => navigation, frame: () => iframePost && method === 'POST' ? {} : frame, headers: vi.fn(() => headers), headerValue: vi.fn(async (name: string) => headers[name]), postDataBuffer: postData };
    requestBodies.push(request);
    await route({ request: () => request, abort, fulfill });
  };
  page.goto = async () => {
    await bindings.__portalContractProbeTimeZone({ frame }, timeZone);
    await dispatch(applyUrl, 'GET', 'document', true);
    await dispatch(scriptUrl, 'GET', 'script');
    await dispatch(protocol.lookupUrl, 'POST', 'xhr');
    if (repeatPost) await dispatch(protocol.lookupUrl, 'POST', 'xhr');
    if (extraPost) await dispatch('https://jobs.example.com/careers/marketing.html', 'POST', 'xhr');
  };
  const context: any = { route: async (_pattern: string, handler: any) => { route = handler; },
    routeWebSocket: async () => {}, exposeBinding: async (name: string, fn: any) => { bindings[name] = fn; },
    addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
  const browser: any = { newContext: async () => context, close: async () => {} };
  const lookup = vi.fn(async (_url: string, options: any) => { options.onRequest(); options.onBytes(response.body.length); return response; });
  const get = async (url: string) => ({ status: 200, url, headers: { 'content-type': url === applyUrl ? 'text/html' : 'text/javascript' }, body: Buffer.from(url === applyUrl ? html : script) });
  return { browser, lookup, get, requestBodies, abort };
}

describe('anonymous browser semantic-read boundary', () => {
  it('permits the one demonstrated lookup and stores only primary source identity in the proof', async () => {
    const fixture = anonymousBrowserFixture();
    const result = await readOnlyPortalContracts({ applyUrl, job: { company: 'Example Motors' }, launch: async () => fixture.browser, get: fixture.get, lookup: fixture.lookup });
    expect(result).toMatchObject({ complete: true, readOnlyProtocol: { name: 'rexx-timezone-lookup-v1', scriptUrl, lookupObserved: true } });
    expect(fixture.lookup).toHaveBeenCalledOnce();
    expect(fixture.requestBodies[2].postDataBuffer).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(body);
    expect(JSON.stringify(result)).not.toContain('Europe/Zurich');
  });

  it.each(['missing_protocol', 'additional_post', 'repeat_same_post', 'iframe_post', 'extra_body_field', 'extra_response_field', 'transient_lookup'])('keeps proof unknown for %s', async kind => {
    const fixture = anonymousBrowserFixture({ script: kind === 'missing_protocol' ? '/* no demonstrated protocol */' : rexxTimeZoneScript,
      extraPost: kind === 'additional_post', repeatPost: kind === 'repeat_same_post', iframePost: kind === 'iframe_post', extraBody: kind === 'extra_body_field', response: kind === 'extra_response_field' ? { ...validResponse, body: Buffer.from('{"success":true,"id":123,"marketing":true}') } : validResponse });
    if (kind === 'transient_lookup') fixture.lookup.mockImplementationOnce(async () => { throw Object.assign(new Error('temporary network failure'), { code: 'EAI_AGAIN' }); });
    const result = await readOnlyPortalContracts({ applyUrl, job: { company: 'Example Motors' }, launch: async () => fixture.browser, get: fixture.get, lookup: fixture.lookup });
    expect(result.complete).toBe(false);
    if (kind === 'transient_lookup') expect(result.reason).toBe('transient_probe_failure');
    expect(fixture.lookup).toHaveBeenCalledTimes(['missing_protocol', 'iframe_post', 'extra_body_field'].includes(kind) ? 0 : 1);
    if (kind === 'missing_protocol') {
      expect(fixture.requestBodies[2].postDataBuffer).not.toHaveBeenCalled();
      expect(fixture.requestBodies[2].headers).not.toHaveBeenCalled();
    }
    if (kind === 'additional_post') expect(fixture.requestBodies[3].postDataBuffer).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(body);
  });
});
