/** Bounded public HTTPS GETs whose connection uses the address already validated. */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
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

export async function publicContractGet(value, {
  resolve = lookup, requestImpl = request, signal = AbortSignal.timeout(12_000), maxBytes = 1_500_000,
  onBytes = () => {}, onRequest = () => {},
} = {}) {
  let current = String(value || '');
  for (let hop = 0; hop <= 3; hop += 1) {
    if (!isFetchablePublicUrl(current)) throw fail('contract_url_unsafe');
    const url = new URL(current);
    const addresses = await withAbort(resolve(url.hostname, { all: true }), signal);
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw fail('contract_dns_unsafe');
    const pinned = addresses[0];
    onRequest();
    const result = await new Promise((accept, reject) => {
      const req = requestImpl(url, {
        method: 'GET', agent: false, signal, servername: url.hostname,
        // Do not perform a second DNS lookup after validating the host.
        lookup: (_host, options, callback) => options?.all
          ? callback(null, [{ address: pinned.address, family: pinned.family }])
          : callback(null, pinned.address, pinned.family),
        headers: { 'User-Agent': 'FrontaliereTicino-PublicContractProbe/1.0', 'Accept-Encoding': 'identity' },
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('error', reject);
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
      req.end();
    });
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      try { current = new URL(result.headers.location, url).href; } catch { throw fail('contract_redirect_invalid'); }
      continue;
    }
    if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') throw fail('contract_encoding_unsupported');
    return result;
  }
  throw fail('contract_redirect_limit');
}
