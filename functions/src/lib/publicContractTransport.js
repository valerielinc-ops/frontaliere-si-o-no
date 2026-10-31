/** Single bounded public transport. Only named callers may enable specialized reads. */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isFetchablePublicUrl, isPrivateAddress } from '../assistedApplicationAiJob.js';

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

export async function publicContractRequest(value, {
  resolve = lookup, requestImpl = request, signal = AbortSignal.timeout(12_000), maxBytes = 1_500_000,
  onBytes = () => {}, onRequest = () => {}, method = 'GET', requestBody = null, followRedirects = true, cookieHeader = null, statusOnlyOn5xx = false, xmlHttpRequest = false, acceptJson = false, beforeRequest = () => {}, validateUrl = () => true,
} = {}) {
  let current = String(value || '');
  for (let hop = 0; hop <= 3; hop += 1) {
    if (!isFetchablePublicUrl(current) || validateUrl(current) !== true) throw fail('contract_url_unsafe');
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
      if (![301, 302, 303, 307, 308].includes(result.status)) throw fail('contract_redirect_status_unknown');
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
