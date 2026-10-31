/** Bounded public reads share the pinned Functions transport; named Rexx guards stay here. */
import { publicContractRequest } from '../../../../functions/src/lib/publicContractTransport.js';
export { publicContractGet } from '../../../../functions/src/lib/publicContractTransport.js';
import { matchesRexxGuestProbe, validRexxGuestResponse } from './rexx-guest-session-contract.mjs';
import { rexxTimeZoneBody, validRexxTimeZoneResponse, rexxTimeZoneResponseReason } from './rexx-timezone-contract.mjs';

function fail(code) { return Object.assign(new Error(code), { code }); }

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
