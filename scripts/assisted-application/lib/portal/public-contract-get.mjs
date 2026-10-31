/** Bounded public HTTPS GETs whose connection uses the address already validated. */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { matchesRexxGuestProbe, validRexxGuestResponse } from './rexx-guest-session-contract.mjs';
import { rexxTimeZoneBody, validRexxTimeZoneResponse, rexxTimeZoneResponseReason } from './rexx-timezone-contract.mjs';
import { isFetchablePublicUrl, isPrivateAddress } from '../../../../functions/src/assistedApplicationAiJob.js';

function fail(code) { return Object.assign(new Error(code), { code }); }

async function withAbort(promise, signal) {
  if (signal.aborted) throw signal.reason;
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

async function publicContractRequest(value, {
  resolve = lookup, requestImpl = request, signal = AbortSignal.timeout(12_000), maxBytes = 1_500_000,
  onBytes = () => {}, onRequest = () => {}, method = 'GET', requestBody = null, followRedirects = true, cookieHeader = null, statusOnlyOn5xx = false, xmlHttpRequest = false, acceptJson = false, beforeRequest = () => {},
} = {}) {
  let current = String(value || '');
  for (let hop = 0; hop <= 3; hop += 1) {
    if (!isFetchablePublicUrl(current)) throw fail('contract_url_unsafe');
    const url = new URL(current);
    const addresses = await withAbort(resolve(url.hostname, { all: true }), signal);
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw fail('contract_dns_unsafe');
    const pinned = addresses[0];
    onRequest();
    beforeRequest();
    const result = await new Promise((accept, reject) => {
      const req = requestImpl(url, {
        method, agent: false, signal, servername: url.hostname,
        // Do not perform a second DNS lookup after validating the host.
        lookup: (_host, options, callback) => options?.all
          ? callback(null, [{ address: pinned.address, family: pinned.family }])
          : callback(null, pinned.address, pinned.family),
        headers: { 'User-Agent': 'FrontaliereTicino-PublicContractProbe/1.0', 'Accept-Encoding': 'identity',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(acceptJson ? { Accept: 'application/json' } : {}),
          ...(method === 'POST' || xmlHttpRequest ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Length': Buffer.byteLength(requestBody) } : {}) },
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('error', reject);
        if (statusOnlyOn5xx && response.statusCode >= 500 && response.statusCode <= 599) {
          accept({ status: response.statusCode, headers: response.headers, body: Buffer.alloc(0), url: url.href });
          response.destroy();
          return;
        }
        response.on('aborted', () => reject(fail('contract_response_aborted')));
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(fail('contract_response_too_large')); return; }
          try { onBytes(chunk.length); } catch (error) { req.destroy(error); return; }
          chunks.push(chunk);
        });
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), url: url.href }));
      });
      req.on('error', reject);
      req.end(requestBody || undefined);
    });
    if (method !== 'GET' && result.status >= 300 && result.status < 400) throw fail('contract_lookup_redirect');
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      if (!followRedirects) throw fail('contract_redirect_not_allowed');
      try { current = new URL(result.headers.location, url).href; } catch { throw fail('contract_redirect_invalid'); }
      continue;
    }
    if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') throw fail('contract_encoding_unsupported');
    return result;
  }
  throw fail('contract_redirect_limit');
}

export function publicContractGet(value, options = {}) {
  return publicContractRequest(value, { ...options, method: 'GET', requestBody: null, cookieHeader: null, statusOnlyOn5xx: false, xmlHttpRequest: false, acceptJson: false, beforeRequest: undefined });
}

/** The public consent loader explicitly requests JSON from this named GET. */
export async function publicContractConsentGeoGet(value, options = {}) {
  if (value !== 'https://geolocation.onetrust.com/cookieconsentpub/v1/geo/location') throw fail('contract_consent_geo_invalid');
  return publicContractRequest(value, { ...options, method: 'GET', requestBody: null,
    maxBytes: Math.min(Number(options.maxBytes) || 4096, 4096), followRedirects: false, cookieHeader: null,
    statusOnlyOn5xx: false, xmlHttpRequest: false, acceptJson: true, beforeRequest: undefined });
}

/** The only semantic read using POST: no cookies/auth, no redirects, bounded JSON. */
export async function publicContractTimeZoneLookup(value, { timeZone, protocol, ...options } = {}) {
  const url = new URL(value);
  const requestBody = rexxTimeZoneBody(timeZone);
  if (!protocol || protocol.name !== 'rexx-timezone-lookup-v1' || protocol.lookupUrl !== url.href
    || new URL(protocol.scriptUrl).origin !== url.origin || !/^[a-f0-9]{64}$/.test(protocol.scriptHash || '')
    || !url.pathname.endsWith('/timezone.html') || !requestBody || Buffer.byteLength(requestBody) > 256 || url.search || url.hash) throw fail('contract_lookup_invalid');
  const response = await publicContractRequest(url.href, { ...options, maxBytes: 2048, method: 'POST', requestBody, followRedirects: false, cookieHeader: null, statusOnlyOn5xx: false, xmlHttpRequest: false, acceptJson: false, beforeRequest: undefined });
  if (!validRexxTimeZoneResponse(response)) throw Object.assign(fail(response.status >= 500 || response.status === 429
    ? 'contract_lookup_transient' : 'contract_lookup_response_unknown'), { status: response.status, responseReason: rexxTimeZoneResponseReason(response) });
  return response;
}

/** One public guest cookie check, with at most its demonstrated 5xx recovery. */
export async function publicContractGuestCookieCheck(value, { protocol, guest, ...options } = {}) {
  if (protocol?.name !== 'rexx-guest-cookie-check-v1'
    || !new URL(protocol.lookupUrl).pathname.endsWith('/cookiecheck-cc0.html')
    || new URL(protocol.lookupUrl).search || new URL(protocol.lookupUrl).hash
    || !/^[a-f0-9]{64}$/.test(protocol.scriptHash || '')
    || new URL(protocol.scriptUrl).origin !== guest?.origin || !matchesRexxGuestProbe(protocol, guest, value)) throw fail('contract_guest_probe_invalid');
  const requestOptions = { ...options, maxBytes: 4096, method: 'GET', requestBody: null,
    cookieHeader: `${guest.name}=${guest.value}`, followRedirects: false, xmlHttpRequest: true, acceptJson: false,
    beforeRequest: () => { if (!(guest.expiresAt === Infinity || Number.isFinite(guest.expiresAt) && guest.expiresAt > Date.now())) throw fail('contract_guest_probe_expired'); } };
  let response = await publicContractRequest(value, { ...requestOptions, statusOnlyOn5xx: true });
  let requests = 1;
  if (response.status >= 500 && response.status <= 599) {
    if (Number(guest.expiresAt) <= Date.now()) throw fail('contract_guest_probe_expired');
    response = await publicContractRequest(protocol.lookupUrl, { ...requestOptions, statusOnlyOn5xx: false });
    requests++;
  }
  if (![value, protocol.lookupUrl].includes(response.url) || !validRexxGuestResponse(response, guest)) {
    throw fail(response.status >= 500 || response.status === 429 ? 'contract_guest_probe_transient' : 'contract_guest_probe_unknown');
  }
  return { ...response, requests, canonicalFallbackUsed: requests === 2 };
}
