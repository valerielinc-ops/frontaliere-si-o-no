/**
 * Polite HTTP for the prospector.
 *
 * The prospector touches thousands of small employer sites that are NOT our
 * partners and never asked to be crawled, so every request goes out under three
 * self-imposed limits: an identifying UA, one request per host per
 * HOST_DELAY_MS, and robots.txt honoured for our own UA. A shop with one web
 * server in a back office must not notice us.
 *
 * robots.txt is fetched once per host and cached for the process lifetime.
 * A robots.txt that cannot be fetched is treated as ALLOW — the same reading a
 * browser takes, and the alternative (deny on error) would silently zero out
 * discovery whenever a CDN hiccups.
 */
import { UA, HOST_DELAY_MS, FETCH_TIMEOUT_MS } from './config.mjs';
import { normalizeHost } from './registrable.mjs';
import { RETRYABLE_STATUS } from '../transient-fetch.mjs';
import {
  createSpecUrlPolicy,
  fetchFollowingValidatedRedirectsWithUrl,
  isPublicFetchPolicyError,
  PublicFetchPolicyError,
} from './public-fetch-policy.mjs';

/** @type {Map<string, number>} host -> timestamp of the last request */
const lastHit = new Map();
/** @type {Map<string, { until: number, generation: number }>} */
const hostCooldown = new Map();
/** @type {Map<string, Promise<{ disallow: string[], allow: string[] }>>} */
const robotsCache = new Map();

const RETRY_AFTER_CAP_MS = 60_000;
const retryAfterHeader = Symbol('retryAfterHeader');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait out the per-host cooldown, then stamp the host as hit.
 * @param {string} host
 */
async function throttle(host, sleepImpl = sleep, nowImpl = Date.now) {
  const now = nowImpl();
  const prev = lastHit.get(host) || 0;
  const cooldown = hostCooldown.get(host) || { until: 0, generation: 0 };
  const slot = Math.max(now, prev + HOST_DELAY_MS, cooldown.until);
  const wait = slot - now;
  // Stamp BEFORE awaiting so concurrent callers on the same host queue behind
  // each other instead of all reading the same stale timestamp and firing together.
  lastHit.set(host, slot);
  if (wait > 0) await sleepImpl(wait);
  // A sibling may receive 429 while this request is already queued. Re-check
  // only when the server cooldown changed; this preserves deterministic test
  // transports whose sleep implementation intentionally does not advance time.
  const latest = hostCooldown.get(host);
  if (latest && latest.generation !== cooldown.generation && latest.until > slot) {
    await throttle(host, sleepImpl, nowImpl);
  }
}

function boundedRetryAfterMs(value, fallbackMs, now) {
  const fallback = Number.isFinite(fallbackMs) ? Math.max(0, fallbackMs) : 0;
  const raw = String(value || '').trim();
  let requested = 0;
  if (/^\d+$/.test(raw)) {
    requested = Number(raw) * 1_000;
  } else if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > now) requested = parsed - now;
  }
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(fallback, requested));
}

function extendHostCooldown(host, delayMs, now) {
  if (!host || !Number.isFinite(delayMs) || delayMs <= 0) return;
  const previous = hostCooldown.get(host) || { until: 0, generation: 0 };
  const until = now + delayMs;
  if (until <= previous.until) return;
  hostCooldown.set(host, { until, generation: previous.generation + 1 });
}

/**
 * Parse the robots.txt groups that apply to us: the `*` group plus any group
 * naming our bot. Longest-match Allow beats Disallow, per the de-facto spec.
 *
 * @param {string} text
 * @returns {{ disallow: string[], allow: string[] }}
 */
export function parseRobots(text = '') {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.rules.push({ type: field, path: value });
    }
  }
  const ua = UA.toLowerCase();
  const applies = (g) => g.agents.some((a) => a === '*' || (a && a !== '*' && ua.includes(a)));
  const rules = groups.filter(applies).flatMap((g) => g.rules);
  return {
    disallow: rules.filter((r) => r.type === 'disallow' && r.path).map((r) => r.path),
    allow: rules.filter((r) => r.type === 'allow' && r.path).map((r) => r.path),
  };
}

/**
 * @param {{ disallow: string[], allow: string[] }} robots
 * @param {string} pathname
 * @returns {boolean}
 */
export function robotsAllows(robots, pathname) {
  const match = (pattern) => {
    // Only `*` and a trailing `$` are honoured — the two wildcards real
    // robots.txt files use. Everything else is a literal prefix.
    const rx = new RegExp('^' + pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$'));
    return rx.test(pathname) ? pattern.length : 0;
  };
  let deny = 0;
  let allow = 0;
  for (const p of robots.disallow) deny = Math.max(deny, match(p));
  for (const p of robots.allow) allow = Math.max(allow, match(p));
  return allow >= deny;
}

/**
 * @param {string} origin e.g. `https://example.ch`
 */
function loadRobots(origin, transport) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const robotsUrlPolicy = async (rawUrl) => {
          const validated = await transport.urlPolicy(rawUrl);
          if (new URL(validated).origin !== origin) {
            throw new PublicFetchPolicyError(`prospector robots origin not allowed: ${new URL(validated).origin}`);
          }
          return validated;
        };
        const r = await fetchOnce(`${origin}/robots.txt`, {
          ...transport,
          timeoutMs: Math.min(8000, transport.timeoutMs || 8000),
          method: 'GET',
          body: undefined,
          urlPolicy: robotsUrlPolicy,
          ignoreRobots: true,
        });
        if (!r.ok) return { disallow: [], allow: [] };
        return parseRobots(r.body);
      } catch (error) {
        // A transient robots failure remains fail-open as documented, but a
        // deterministic URL/DNS policy rejection must stop the whole request.
        // Otherwise the main fetch repeats the unsafe lookup after robots has
        // already proved the origin forbidden.
        if (isPublicFetchPolicyError(error)) {
          robotsCache.delete(origin);
          throw error;
        }
        return { disallow: [], allow: [] };
      }
    })());
  }
  return robotsCache.get(origin);
}

class RobotsDeniedError extends Error {
  /** @param {string} url */
  constructor(url) {
    super(`robots.txt disallows prospector URL: ${url}`);
    this.name = 'RobotsDeniedError';
    this.url = url;
  }
}

/**
 * Fetch a URL politely. Never throws: a failure is a result with `ok:false`,
 * because at prospector scale an exception per unreachable SME site would turn
 * every run into an error-handling exercise instead of a discovery run.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, accept?: string, ignoreRobots?: boolean, method?: string, body?: string, contentType?: string, headers?: Record<string,string|undefined>, retries?: number, retryBaseMs?: number, maxRedirects?: number, fetchImpl?: typeof fetch, lookupImpl?: any, urlPolicy?: any, dispatcher?: unknown, signal?: AbortSignal, sleepImpl?: (ms: number) => Promise<unknown>, nowImpl?: () => number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, url: string, body: string, host: string, blockedByRobots?: boolean, policyBlocked?: boolean, error?: string }>}
 */
export async function politeFetch(url, opts = {}) {
  let parsed;
  try { parsed = new URL(url); } catch {
    return { ok: false, status: 0, url, body: '', host: '' };
  }
  const host = normalizeHost(parsed.hostname);
  let policy;
  let ownsPolicy = false;
  try {
    policy = opts.urlPolicy || createSpecUrlPolicy(
      { seedUrls: [url] },
      { lookupImpl: opts.lookupImpl },
    );
    ownsPolicy = !opts.urlPolicy;
    await policy(url);

    const transport = {
      ...opts,
      host,
      urlPolicy: policy,
      dispatcher: opts.dispatcher || policy.dispatcher,
    };
    // Keep the shared fetch contract: `retries` counts attempts AFTER the
    // first request. The old runtime used the shared default of three retries
    // (four attempts total); treating the option as an attempt count silently
    // removed resilience from every promoted crawler.
    const configuredRetries = Number(opts.retries ?? 3);
    const retryCount = Number.isFinite(configuredRetries)
      ? Math.max(0, Math.floor(configuredRetries))
      : 3;
    const attempts = retryCount + 1;
    let last = { ok: false, status: 0, url, body: '', host };
    let retryViaHostCooldown = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && !retryViaHostCooldown) {
        await (opts.sleepImpl || sleep)((opts.retryBaseMs ?? 1500) * attempt);
      }
      retryViaHostCooldown = false;
      try {
        last = await fetchOnce(url, transport);
      } catch (error) {
        last = {
          ok: false,
          status: 0,
          url: error instanceof RobotsDeniedError ? error.url : url,
          body: '',
          host,
          ...(error instanceof RobotsDeniedError ? { blockedByRobots: true } : {}),
          ...(isPublicFetchPolicyError(error)
            ? { policyBlocked: true, error: String(error?.message || error) }
            : {}),
        };
      }
      if (last.status === 429) {
        const fallbackMs = Number(opts.retryBaseMs ?? 1500) * (attempt + 1);
        const now = (opts.nowImpl || Date.now)();
        const cooldownMs = boundedRetryAfterMs(last[retryAfterHeader], fallbackMs, now);
        extendHostCooldown(last.host || host, cooldownMs, now);
        retryViaHostCooldown = true;
      }
      // Retry only what a retry can fix. Policy failures, 4xx and successful
      // responses are final; connection failures/5xx retain bounded retries.
      if (last.ok || last.policyBlocked || last.blockedByRobots
        || (last.status > 0 && !RETRYABLE_STATUS.has(last.status))) return last;
    }
    return last;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: '',
      host,
      ...(isPublicFetchPolicyError(error)
        ? { policyBlocked: true, error: String(error?.message || error) }
        : {}),
    };
  } finally {
    if (ownsPolicy) await policy?.dispatcher?.close?.();
  }
}

/**
 * One attempt, throttled. Split out so the retry loop above re-throttles per
 * attempt instead of hammering a host that just failed.
 *
 * @param {string} url
 * @param {Record<string, any>} opts
 */
async function fetchOnce(url, opts) {
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const headers = {
    'User-Agent': UA,
    Accept: opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it,de;q=0.9,fr;q=0.8,en;q=0.7',
  };
  if (opts.body) headers['Content-Type'] = opts.contentType || 'application/json';
  // Explicit overrides win, and an explicit `undefined` REMOVES a default —
  // Overpass runs behind an Apache that answers 406 to our Accept-Language,
  // so a source must be able to drop a header, not just replace it.
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v === undefined) delete headers[k]; else headers[k] = v;
  }
  // The signal identifies one logical attempt across redirects. Keep that
  // identity stable for observers, but arm a fresh timer only around actual
  // network work so robots/throttle/cooldown waits cannot consume its budget.
  const ac = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, ac.signal])
    : ac.signal;
  const withNetworkTimeout = async (operation) => {
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
    try {
      return await operation();
    } finally {
      clearTimeout(timer);
    }
  };
  const fetchImpl = (hopUrl, init = {}) => withNetworkTimeout(
    () => (opts.fetchImpl || fetch)(hopUrl, { ...init, signal }),
  );
  const { response: res, effectiveUrl } = await fetchFollowingValidatedRedirectsWithUrl(url, {
    fetchImpl,
    validateUrl: opts.urlPolicy,
    maxRedirects: opts.maxRedirects ?? 5,
    beforeRequest: async (hopUrl) => {
      const hop = new URL(hopUrl);
      const hopHost = normalizeHost(hop.hostname);
      if (!opts.ignoreRobots) {
        const robots = await loadRobots(hop.origin, {
          ...opts,
          host: hopHost,
        });
        if (!robotsAllows(robots, `${hop.pathname}${hop.search}`)) {
          throw new RobotsDeniedError(hopUrl);
        }
      }
      // Every actual request — including every redirect and robots fetch —
      // consumes the destination host's slot. Cross-origin allowlisted hops
      // therefore cannot borrow the seed host's throttle budget. Robots is
      // loaded first so a policy/DNS rejection does not reserve a phantom
      // target request or create what looks like retry backoff.
      await throttle(hopHost, opts.sleepImpl || sleep, opts.nowImpl || Date.now);
    },
    requestOptions: {
      method,
      ...(opts.signal ? { signal: opts.signal } : {}),
      headers,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      ...(opts.body ? { body: opts.body } : {}),
    },
  });
  const effectiveHost = normalizeHost(new URL(effectiveUrl).hostname);
  const rawRetryAfter = res.headers?.get?.('retry-after') || null;
  if (res.status === 429) {
    const now = (opts.nowImpl || Date.now)();
    const fallbackMs = Number(opts.retryBaseMs ?? 1500);
    extendHostCooldown(
      effectiveHost,
      boundedRetryAfterMs(rawRetryAfter, fallbackMs, now),
      now,
    );
  }
  const body = method === 'HEAD' ? '' : await withNetworkTimeout(() => res.text());
  return {
    ok: res.ok,
    status: res.status,
    url: effectiveUrl,
    body,
    host: effectiveHost,
    [retryAfterHeader]: rawRetryAfter,
  };
}

/** Test-only state reset: avoids cross-test robots/throttle cache coupling. */
export function clearPoliteFetchStateForTests() {
  lastHit.clear();
  hostCooldown.clear();
  robotsCache.clear();
}

/**
 * Run `worker` over `items` with a fixed number of parallel lanes.
 * Results keep the input order; a worker that throws yields `null`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} lanes
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<(R|null)[]>}
 */
export async function mapPool(items, lanes, worker) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await worker(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}
