import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { rexxGuestSessionScript } from './fixtures/rexx-guest-session-contract.mjs';
import { initialRexxGuestSession, rexxGuestSessionProtocol, matchesRexxGuestProbe, validRexxGuestResponse } from '../scripts/assisted-application/lib/portal/rexx-guest-session-contract.mjs';
import { readOnlyPortalContracts } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';
import { publicContractGet, publicContractGuestCookieCheck, publicContractTimeZoneLookup } from '../scripts/assisted-application/lib/portal/public-contract-get.mjs';

const applyUrl = 'https://jobs.example.com/apply/';
const scriptUrl = 'https://jobs.example.com/upload.js';
const lookupUrl = 'https://jobs.example.com/cookiecheck-cc0.html';
const sid = 'synthetic_guest_session_1234567890';
const html = `<script src='${scriptUrl}'></script><script>upload.InitChunckedUpload('file','/upload',1,'cv',{},'sid','${sid}');</script>`;
const guest = initialRexxGuestSession(html, applyUrl, [`sid=${sid}; Path=/; Secure; HttpOnly`, 'other_cookie=ignored; Path=/'], lookupUrl);
const protocol = rexxGuestSessionProtocol({ scripts: [scriptUrl], lookupUrl: 'https://jobs.example.com/timezone.html' }, scriptUrl, Buffer.from(rexxGuestSessionScript));
const target = `${lookupUrl}?sid=${sid}`;
const response = (data: any) => ({ status: 200, url: lookupUrl, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(data)) });

describe('fresh public guest cookie identity', () => {
  it('uses only the unique document SID matched by the initial HTTPS response cookie', () => {
    expect(guest).toMatchObject({ name: 'sid', value: sid, origin: 'https://jobs.example.com' });
    expect(guest.browserCookie).toMatchObject({ name: 'sid', domain: 'jobs.example.com', path: '/', secure: true, httpOnly: true });
    expect(protocol).toMatchObject({ name: 'rexx-guest-cookie-check-v1', lookupUrl, scriptUrl });
    expect(matchesRexxGuestProbe(protocol, guest, target)).toBe(true);
  });

  it('treats bounded identical Set-Cookie declarations as one initial guest cookie', () => {
    const cookie = `sid=${sid}; Path=/; Secure; HttpOnly`;
    expect(initialRexxGuestSession(html, applyUrl, [cookie, cookie], lookupUrl)?.value).toBe(sid);
    expect(initialRexxGuestSession(html, applyUrl, Array(9).fill(cookie), lookupUrl)).toBeNull();
  });

  it.each(['mismatch', 'duplicate_cookie', 'duplicate_page', 'wrong_domain', 'wrong_path', 'expired', 'private_link', 'inert'])('grants no guest context for %s', kind => {
    let page = html, url = applyUrl, cookies = [`sid=${sid}; Path=/; Secure`];
    if (kind === 'mismatch') cookies = ['sid=different_guest_session_1234567890; Path=/; Secure'];
    if (kind === 'duplicate_cookie') cookies.push(`sid=${sid}; Path=/; Secure; HttpOnly`);
    if (kind === 'duplicate_page') page += `<script>upload.InitChunckedUpload('file','/upload',1,'cv',{},'sid','different_guest_session_1234567890');</script>`;
    if (kind === 'wrong_domain') cookies = [`sid=${sid}; Domain=other.example.com; Path=/; Secure`];
    if (kind === 'wrong_path') cookies = [`sid=${sid}; Path=/private/; Secure`];
    if (kind === 'expired') cookies = [`sid=${sid}; Path=/; Max-Age=0; Secure`];
    if (kind === 'private_link') url += '?auth_token=private';
    if (kind === 'inert') page = `<template>${html}</template>`;
    expect(initialRexxGuestSession(page, url, cookies, lookupUrl)).toBeNull();
  });

  it('rejects unsupported script semantics, ambiguous sources and private probe URL changes', () => {
    expect(rexxGuestSessionProtocol({ scripts: [scriptUrl], lookupUrl }, scriptUrl, Buffer.from(rexxGuestSessionScript.replace("method:'GET'", "method:'POST'")))).toBeNull();
    expect(rexxGuestSessionProtocol({ scripts: [scriptUrl, scriptUrl], lookupUrl }, scriptUrl, Buffer.from(rexxGuestSessionScript))).toBeNull();
    for (const url of [`${target}&save=1`, `${lookupUrl}?sid=other`, target.replace('jobs.example.com', 'other.example.com'), `${target}#private`]) expect(matchesRexxGuestProbe(protocol, guest, url)).toBe(false);
    expect(matchesRexxGuestProbe(protocol, { ...guest, expiresAt: 1 }, target)).toBe(false);
  });

  it('accepts only true and the identical guest SID, without duplicate or extra keys', () => {
    expect(validRexxGuestResponse(response({ cookie_allowed: true, session_id: sid }), guest)).toBe(true);
    for (const data of [{ cookie_allowed: false, session_id: sid }, { cookie_allowed: true, session_id: 'other' }, { cookie_allowed: true, session_id: sid, extra: true }]) expect(validRexxGuestResponse(response(data), guest)).toBe(false);
    expect(validRexxGuestResponse({ ...response({}), body: Buffer.from(`{"cookie_allowed":true,"session_id":"${sid}","\\u0073ession_id":"${sid}"}`) }, guest)).toBe(false);
  });
});

function transport(statuses: number[], replySid = sid) {
  const calls: any[] = [];
  const requestImpl = (url: URL, options: any, callback: any) => {
    const req: any = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const status = statuses.shift() || 200;
      calls.push({ url, options });
      const res: any = Readable.from([status >= 500 ? Buffer.alloc(10_000) : response({ cookie_allowed: true, session_id: replySid }).body]);
      res.statusCode = status;
      res.headers = { 'content-type': 'application/json', 'set-cookie': ['sid=untrusted_replacement; Path=/; Secure'], ...(status === 302 ? { location: 'https://public.example.com/action' } : {}) };
      callback(res);
    });
    return req;
  };
  return { calls, requestImpl, resolve: async () => [{ address: '93.184.216.34', family: 4 }] };
}

describe('bounded anonymous cookie probe transport', () => {
  it('does only the actual query GET and one canonical recovery after 5xx, keeping the initial guest SID', async () => {
    const fixture = transport([500, 200]);
    const result = await publicContractGuestCookieCheck(target, { ...fixture, protocol, guest });
    expect(result).toMatchObject({ requests: 2, canonicalFallbackUsed: true });
    expect(fixture.calls.map(call => call.url.href)).toEqual([target, lookupUrl]);
    for (const call of fixture.calls) {
      expect(call.options).toMatchObject({ method: 'GET', agent: false, servername: 'jobs.example.com' });
      expect(call.options.headers.Cookie).toBe(`sid=${sid}`);
      expect(call.options.headers).not.toHaveProperty('Authorization');
      expect(call.options.headers.Cookie).not.toContain('other_cookie');
      expect(call.options.headers.Cookie).not.toContain('untrusted_replacement');
    }
    expect(guest.value).toBe(sid);
  });

  it('does not follow redirects, replay non-5xx failures or accept a changed server session', async () => {
    const redirect = transport([302]);
    await expect(publicContractGuestCookieCheck(target, { ...redirect, protocol, guest })).rejects.toThrow('contract_redirect_not_allowed');
    expect(redirect.calls).toHaveLength(1);
    const mismatch = transport([200], 'different_guest_session_1234567890');
    await expect(publicContractGuestCookieCheck(target, { ...mismatch, protocol, guest })).rejects.toThrow('contract_guest_probe_unknown');
    expect(mismatch.calls).toHaveLength(1);
  });

  it('checks expiry after DNS immediately before creating the cookie-bearing request', async () => {
    const expiring = { ...guest, expiresAt: Date.now() + 1000 };
    const requestImpl = vi.fn();
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(realNow);
    try {
      await expect(publicContractGuestCookieCheck(target, { protocol, guest: expiring, requestImpl,
        resolve: async () => { clock.mockReturnValue(expiring.expiresAt + 1); return [{ address: '93.184.216.34', family: 4 }]; } })).rejects.toThrow('contract_guest_probe_expired');
      expect(requestImpl).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('cannot attach a guest cookie to public asset GETs or timezone POSTs through options', async () => {
    const get = transport([200]);
    await publicContractGet('https://jobs.example.com/code.js', { ...get, cookieHeader: `sid=${sid}` });
    expect(get.calls[0].options.headers).not.toHaveProperty('Cookie');
    // The timezone wrapper also overrides cookieHeader; inspect the request even
    // though this cookie-shaped reply deliberately is not a timezone reply.
    const timezone = transport([200]);
    await expect(publicContractTimeZoneLookup('https://jobs.example.com/timezone.html', { ...timezone,
      protocol: { name: 'rexx-timezone-lookup-v1', lookupUrl: 'https://jobs.example.com/timezone.html', scriptUrl, scriptHash: 'a'.repeat(64) }, timeZone: 'UTC', cookieHeader: `sid=${sid}` })).rejects.toThrow();
    expect(timezone.calls[0].options.headers).not.toHaveProperty('Cookie');
  });
});


function guestBrowserFixture({ mismatch = false, privateField = false, encodedField = false, encodedDenied = false } = {}) {
  let route: any;
  const frame: any = { url: () => applyUrl, evaluate: async () => ({ url: applyUrl, fields: [
    { id: 'source', form: 0, kind: 'select', label: privateField ? `Recruitment source ${sid}` : encodedField ? `Recruitment source ${sid.replaceAll('_', '%5F')}` : 'Recruitment source', required: false, options: [{ value: 'web', label: 'Website' }] },
    { id: 'cv', form: 0, kind: 'file', inputType: 'file', label: 'CV', required: true },
    { id: 'email', form: 0, kind: 'text', inputType: 'email', label: 'Email', required: true },
  ], buttons: [], text: 'Example Motors', errors: [], captcha: false, passwordVisible: false }) };
  const page: any = { mainFrame: () => frame, frames: () => [frame], url: () => applyUrl,
    evaluate: async () => [{ id: 'source', explicitlyOptional: true, nativeRequired: false }],
    locator: () => ({ innerText: async () => 'Example Motors' }), waitForTimeout: async () => {}, waitForLoadState: async () => {},
    goto: async () => {
      for (const [url, type] of [[scriptUrl, 'script'], [target, 'xhr'], ...(encodedDenied ? [[`https://jobs.example.com/${sid.replaceAll('_', '%5F')}`, 'xhr']] : [])]) await route({ request: () => ({ url: () => url, method: () => 'GET', resourceType: () => type, isNavigationRequest: () => false, frame: () => frame }), abort: async () => {}, fulfill: async () => {} });
    } };
  const context: any = { addCookies: vi.fn(async () => {}), route: async (_: string, fn: any) => { route = fn; }, routeWebSocket: async () => {}, exposeBinding: async () => {}, addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
  const guestProbe = vi.fn(async () => ({ ...response({ cookie_allowed: true, session_id: mismatch ? 'different' : sid }), requests: 2, canonicalFallbackUsed: true }));
  const document = `<script>var base_url_rexx='https://jobs.example.com/';</script>${html}`;
  const get = async (url: string) => ({ status: 200, url, headers: { 'content-type': url === applyUrl ? 'text/html' : 'text/javascript', ...(url === applyUrl ? { 'set-cookie': [`sid=${sid}; Path=/; Secure; HttpOnly`] } : {}) }, body: Buffer.from(url === applyUrl ? document : rexxGuestSessionScript) });
  return { context, guestProbe, get, browser: { newContext: async () => context, close: async () => {} } };
}

describe('anonymous guest cookie proof privacy', () => {
  it('installs only the fresh guest cookie and exports enums/counts without any SID', async () => {
    const fixture = guestBrowserFixture();
    const proof = await readOnlyPortalContracts({ applyUrl, job: { company: 'Example Motors' }, launch: async () => fixture.browser, get: fixture.get, guestProbe: fixture.guestProbe });
    expect(proof).toMatchObject({ complete: true, guestSessionProof: { protocol: 'rexx-guest-cookie-check-v1', requests: 2, cookieAllowed: true, canonicalFallbackUsed: true } });
    expect(fixture.context.addCookies).toHaveBeenCalledOnce();
    expect(fixture.context.addCookies.mock.calls[0][0]).toHaveLength(1);
    expect(JSON.stringify(proof)).not.toContain(sid);
  });

  it.each(['mismatch', 'private_field', 'encoded_field', 'encoded_denied'])('keeps the proof unknown instead of exporting %s', async kind => {
    const fixture = guestBrowserFixture({ mismatch: kind === 'mismatch', privateField: kind === 'private_field', encodedField: kind === 'encoded_field', encodedDenied: kind === 'encoded_denied' });
    const proof = await readOnlyPortalContracts({ applyUrl, job: { company: 'Example Motors' }, launch: async () => fixture.browser, get: fixture.get, guestProbe: fixture.guestProbe });
    expect(proof.complete).toBe(false);
    expect(JSON.stringify(proof)).not.toContain(sid);
    expect(JSON.stringify(proof)).not.toContain(sid.replaceAll('_', '%5F'));
  });
});
