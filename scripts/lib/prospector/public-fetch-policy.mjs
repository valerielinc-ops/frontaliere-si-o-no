/**
 * Public-network-only transport policy for Prospector-controlled URLs.
 *
 * URL syntax/origin is checked before a request is attempted. DNS is checked
 * again by the lookup passed to Undici at socket-connect time, so the address
 * that was approved is the address that is connected to (no DNS-rebinding
 * pre-check/connection TOCTOU). Redirects stay manual and every requested,
 * effective and Location URL is validated before the next hop.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
/** @type {[string, number][]} */
const NON_PUBLIC_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [network, prefix] of NON_PUBLIC_IPV4_RANGES) {
  NON_PUBLIC_IPV4_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}

const PUBLIC_IPV4_SPECIAL_EXCEPTIONS = new BlockList();
// IANA IPv4 Special-Purpose Address Space snapshot 2025-06-24: these are the
// only globally reachable addresses inside otherwise non-public 192.0.0.0/24.
PUBLIC_IPV4_SPECIAL_EXCEPTIONS.addAddress('192.0.0.9', 'ipv4');
PUBLIC_IPV4_SPECIAL_EXCEPTIONS.addAddress('192.0.0.10', 'ipv4');

const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();
/** @type {[string, number][]} */
// Snapshot: IANA IPv6 Special-Purpose Address Space, last updated
// 2025-10-09 (checked 2026-08-31). TEREDO, deprecated ORCHID and 6to4 are
// fail-closed because IANA records global reachability as N/A/blank.
const NON_PUBLIC_IPV6_RANGES = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['100:0:0:1::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [network, prefix] of NON_PUBLIC_IPV6_RANGES) {
  NON_PUBLIC_IPV6_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

const IETF_PROTOCOL_ASSIGNMENTS_IPV6 = new BlockList();
IETF_PROTOCOL_ASSIGNMENTS_IPV6.addSubnet('2001::', 23, 'ipv6');
const PUBLIC_IETF_PROTOCOL_ASSIGNMENTS_IPV6 = new BlockList();
/** @type {[string, number][]} */
const PUBLIC_IETF_PROTOCOL_ASSIGNMENT_RANGES = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:1::3', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28],
];
for (const [network, prefix] of PUBLIC_IETF_PROTOCOL_ASSIGNMENT_RANGES) {
  PUBLIC_IETF_PROTOCOL_ASSIGNMENTS_IPV6.addSubnet(network, prefix, 'ipv6');
}

const PUBLIC_IPV6_ALLOCATIONS = new BlockList();
/** @type {[string, number][]} */
// Positive snapshot of IANA's IPv6 Global Unicast Address Space registry,
// updated 2025-10-10 and checked 2026-08-31. Reserved gaps are intentionally
// absent: new allocations fail closed until this versioned table is reviewed.
// `2001::/23` is further restricted to its globally reachable special-purpose
// subprefixes below. `64:ff9b::/96` is the sole public exception outside GUA.
const PUBLIC_IPV6_ALLOCATION_RANGES = [
  ['64:ff9b::', 96],
  ['2001::', 23],
  ['2001:200::', 23],
  ['2001:400::', 23],
  ['2001:600::', 23],
  ['2001:800::', 22],
  ['2001:c00::', 23],
  ['2001:e00::', 23],
  ['2001:1200::', 23],
  ['2001:1400::', 22],
  ['2001:1800::', 23],
  ['2001:1a00::', 23],
  ['2001:1c00::', 22],
  ['2001:2000::', 19],
  ['2001:4000::', 23],
  ['2001:4200::', 23],
  ['2001:4400::', 23],
  ['2001:4600::', 23],
  ['2001:4800::', 23],
  ['2001:4a00::', 23],
  ['2001:4c00::', 23],
  ['2001:5000::', 20],
  ['2001:8000::', 19],
  ['2001:a000::', 20],
  ['2001:b000::', 20],
  ['2002::', 16],
  ['2003::', 18],
  ['2400::', 12],
  ['2410::', 12],
  ['2600::', 12],
  ['2610::', 23],
  ['2620::', 23],
  ['2630::', 12],
  ['2800::', 12],
  ['2a00::', 12],
  ['2a10::', 12],
  ['2c00::', 12],
];
for (const [network, prefix] of PUBLIC_IPV6_ALLOCATION_RANGES) {
  PUBLIC_IPV6_ALLOCATIONS.addSubnet(network, prefix, 'ipv6');
}

const NAT64_WELL_KNOWN_PREFIX = new BlockList();
NAT64_WELL_KNOWN_PREFIX.addSubnet('64:ff9b::', 96, 'ipv6');

function isNonPublicIpv4(address) {
  if (PUBLIC_IPV4_SPECIAL_EXCEPTIONS.check(address, 'ipv4')) return false;
  return NON_PUBLIC_IPV4_ADDRESSES.check(address, 'ipv4');
}

/** @param {string} address @returns {number[]|null} */
function parseIpv6Words(address) {
  let input = String(address || '').toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const separator = input.lastIndexOf(':');
    const octets = input.slice(separator + 1).split('.').map(Number);
    if (separator === -1 || octets.length !== 4
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    input = `${input.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => half ? half.split(':').map((word) => {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return Number.NaN;
    return Number.parseInt(word, 16);
  }) : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if ([...left, ...right].some(Number.isNaN)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array(omitted).fill(0), ...right];
}

/** @param {string} address @returns {string|null} */
function nat64EmbeddedIpv4(address) {
  if (!NAT64_WELL_KNOWN_PREFIX.check(address, 'ipv6')) return null;
  const words = parseIpv6Words(address);
  if (!words || words.length !== 8) return null;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

export class PublicFetchPolicyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PublicFetchPolicyError';
    this.code = 'ERR_PUBLIC_FETCH_POLICY';
    this.retryable = false;
  }
}

/**
 * Undici wraps lookup failures in TypeError/cause chains. Recognise our policy
 * error through every wrapper so callers never retry a deterministically
 * forbidden target.
 * @param {unknown} error
 */
export function isPublicFetchPolicyError(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
    seen.add(current);
    const candidate = /** @type {any} */ (current);
    if (candidate instanceof PublicFetchPolicyError
      || candidate.code === 'ERR_PUBLIC_FETCH_POLICY'
      || candidate.retryable === false && /^unsafe prospector|^prospector URL|^credentials forbidden|^no public prospector/i.test(String(candidate.message || ''))) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function isPrivateOrLocalAddress(address = '') {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(value);
  if (family === 4) return isNonPublicIpv4(value);
  if (family !== 6) return false;
  if (!PUBLIC_IPV6_ALLOCATIONS.check(value, 'ipv6')) return true;
  if (NAT64_WELL_KNOWN_PREFIX.check(value, 'ipv6')) {
    const embeddedIpv4 = nat64EmbeddedIpv4(value);
    if (!embeddedIpv4 || isNonPublicIpv4(embeddedIpv4)) return true;
  }
  if (IETF_PROTOCOL_ASSIGNMENTS_IPV6.check(value, 'ipv6')
    && !PUBLIC_IETF_PROTOCOL_ASSIGNMENTS_IPV6.check(value, 'ipv6')) return true;
  return NON_PUBLIC_IPV6_ADDRESSES.check(value, 'ipv6');
}

async function resolvePublicAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((entry) => {
      const address = String(entry?.address || entry || '').split('%')[0];
      return { address, family: Number(entry?.family) || isIP(address) };
    })
    .filter(({ address, family }) => address && (family === 4 || family === 6) && isIP(address) === family);
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrLocalAddress(address))) {
    throw new PublicFetchPolicyError(`unsafe prospector DNS target: ${hostname}`);
  }
  return addresses;
}

/**
 * Resolve at socket-connect time and hand Undici only already-validated IPs.
 * @param {typeof dnsLookup} [lookupImpl]
 */
export function createPublicConnectionLookup(lookupImpl = dnsLookup) {
  return (hostname, options, callback) => {
    const requestedFamily = Number(typeof options === 'number' ? options : options?.family) || 0;
    Promise.resolve(resolvePublicAddresses(hostname, lookupImpl)).then((addresses) => {
      const eligible = requestedFamily
        ? addresses.filter(({ family }) => family === requestedFamily)
        : addresses;
      if (!eligible.length) {
        throw new PublicFetchPolicyError(`no public prospector DNS target for requested family: ${hostname}`);
      }
      if (typeof options === 'object' && options?.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    }).catch((error) => callback(error));
  };
}

function assertSafeLiteralHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || isPrivateOrLocalAddress(host)) {
    throw new PublicFetchPolicyError(`unsafe prospector URL host: ${host || '[empty]'}`);
  }
}

/**
 * Exact-origin policy for a promoted or prospective spec. Seeds define the
 * allowed origins; reviewed ATS/CDN origins must be explicit.
 *
 * @param {{ seedUrls?: string[], allowedDetailOrigins?: string[] }} spec
 * @param {{ lookupImpl?: typeof dnsLookup }} [options]
 */
export function createSpecUrlPolicy(spec, { lookupImpl = dnsLookup } = {}) {
  const configured = [...(spec.seedUrls || []), ...(spec.allowedDetailOrigins || [])];
  const allowedOrigins = new Set();
  for (const raw of configured) {
    try {
      const url = new URL(raw);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
        allowedOrigins.add(url.origin);
      }
    } catch (error) {
      if (isPublicFetchPolicyError(error)) throw error;
      // Invalid configured URLs remain absent and are rejected on use.
    }
  }
  const validateUrl = async (rawUrl) => {
    let url;
    try { url = new URL(rawUrl); } catch { throw new PublicFetchPolicyError('invalid prospector URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new PublicFetchPolicyError('unsafe prospector URL protocol');
    }
    if (url.username || url.password) {
      throw new PublicFetchPolicyError('credentials forbidden in prospector URL');
    }
    if (!allowedOrigins.has(url.origin)) {
      throw new PublicFetchPolicyError(`prospector URL origin not allowed: ${url.origin}`);
    }
    assertSafeLiteralHost(url.hostname);
    return url.toString();
  };
  const connectionLookup = createPublicConnectionLookup(lookupImpl);
  validateUrl.allowedOrigins = allowedOrigins;
  validateUrl.connectionLookup = connectionLookup;
  validateUrl.dispatcher = new Agent({ connect: { lookup: connectionLookup } });
  return validateUrl;
}

/**
 * Follow redirects only after validating every requested, effective and next
 * URL. The caller must pass the policy's dispatcher in requestOptions so DNS
 * validation and the actual socket connection are the same operation.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, validateUrl?: (url: string) => Promise<unknown>|unknown, requestOptions?: RequestInit & { dispatcher?: unknown }, maxRedirects?: number, beforeRequest?: (url: string, context: { redirectCount: number }) => Promise<unknown>|unknown }} [options]
 */
export async function fetchFollowingValidatedRedirects(url, {
  fetchImpl = fetch,
  validateUrl,
  requestOptions = {},
  maxRedirects = 5,
  beforeRequest,
} = {}) {
  const { response } = await fetchFollowingValidatedRedirectsWithUrl(url, {
    fetchImpl,
    validateUrl,
    requestOptions,
    maxRedirects,
    beforeRequest,
  });
  return response;
}

/**
 * Metadata-preserving variant used by the polite crawler transport. Native
 * fetch responses supplied by tests and adapters do not always expose `.url`,
 * while the redirect loop necessarily knows the final URL. Keeping it here
 * prevents relative vacancy links from being resolved against a stale seed.
 *
 * `beforeRequest` runs after URL validation and immediately before every
 * network hop. Callers use it for per-origin robots and host throttling; it is
 * deliberately inside this loop so redirects cannot bypass either invariant.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, validateUrl?: (url: string) => Promise<unknown>|unknown, requestOptions?: RequestInit & { dispatcher?: unknown }, maxRedirects?: number, beforeRequest?: (url: string, context: { redirectCount: number }) => Promise<unknown>|unknown }} [options]
 */
export async function fetchFollowingValidatedRedirectsWithUrl(url, {
  fetchImpl = fetch,
  validateUrl,
  requestOptions = {},
  maxRedirects = 5,
  beforeRequest,
} = {}) {
  let current = String(url || '');
  let currentOptions = { ...requestOptions };
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    if (validateUrl) await validateUrl(current);
    if (beforeRequest) await beforeRequest(current, { redirectCount });
    const res = await fetchImpl(current, { ...currentOptions, redirect: 'manual' });
    const effectiveUrl = res.url || current;
    if (validateUrl) await validateUrl(effectiveUrl);
    if (res.status < 300 || res.status >= 400) return { response: res, effectiveUrl };
    const location = res.headers?.get?.('location');
    if (!location) return { response: res, effectiveUrl };
    if (redirectCount >= maxRedirects) {
      throw new PublicFetchPolicyError(`Too many redirects (>${maxRedirects}) fetching ${url}`);
    }
    await res.body?.cancel?.();
    current = new URL(location, effectiveUrl).toString();
    if (validateUrl) await validateUrl(current);
    const method = String(currentOptions.method || 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const headers = { ...(currentOptions.headers || {}) };
      for (const key of Object.keys(headers)) {
        if (/^content-(?:length|type)$/i.test(key)) delete headers[key];
      }
      currentOptions = { ...currentOptions, method: 'GET', headers };
      delete currentOptions.body;
    }
  }
  throw new PublicFetchPolicyError(`Redirect validation failed for ${url}`);
}
