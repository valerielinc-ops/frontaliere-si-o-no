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

/** @type {Map<string, number>} host -> timestamp of the last request */
const lastHit = new Map();
/** @type {Map<string, Promise<{ disallow: string[], allow: string[] }>>} */
const robotsCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait out the per-host cooldown, then stamp the host as hit.
 * @param {string} host
 */
async function throttle(host) {
  const now = Date.now();
  const prev = lastHit.get(host) || 0;
  const wait = prev + HOST_DELAY_MS - now;
  // Stamp BEFORE awaiting so concurrent callers on the same host queue behind
  // each other instead of all reading the same stale timestamp and firing together.
  lastHit.set(host, Math.max(now, prev + HOST_DELAY_MS));
  if (wait > 0) await sleep(wait);
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
function loadRobots(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 8000);
        const r = await fetch(`${origin}/robots.txt`, { signal: ac.signal, headers: { 'User-Agent': UA } });
        clearTimeout(t);
        if (!r.ok) return { disallow: [], allow: [] };
        return parseRobots(await r.text());
      } catch {
        return { disallow: [], allow: [] };
      }
    })());
  }
  return robotsCache.get(origin);
}

/**
 * Fetch a URL politely. Never throws: a failure is a result with `ok:false`,
 * because at prospector scale an exception per unreachable SME site would turn
 * every run into an error-handling exercise instead of a discovery run.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, accept?: string, ignoreRobots?: boolean, method?: string, body?: string, contentType?: string, headers?: Record<string,string>, retries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, url: string, body: string, host: string, blockedByRobots?: boolean }>}
 */
export async function politeFetch(url, opts = {}) {
  let parsed;
  try { parsed = new URL(url); } catch {
    return { ok: false, status: 0, url, body: '', host: '' };
  }
  const host = normalizeHost(parsed.hostname);
  const origin = `${parsed.protocol}//${parsed.host}`;

  if (!opts.ignoreRobots) {
    const robots = await loadRobots(origin);
    if (!robotsAllows(robots, parsed.pathname)) {
      return { ok: false, status: 0, url, body: '', host, blockedByRobots: true };
    }
  }

  const attempts = Math.max(1, opts.retries ?? 1);
  let last = { ok: false, status: 0, url, body: '', host };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    last = await once(url, opts, host);
    // Retry only what a retry can fix: a connection-level failure or a 5xx.
    // A 404 or a 403 is an answer, and asking again is just rudeness.
    if (last.ok || (last.status > 0 && last.status < 500)) return last;
  }
  return last;
}

/**
 * One attempt, throttled. Split out so the retry loop above re-throttles per
 * attempt instead of hammering a host that just failed.
 *
 * @param {string} url
 * @param {Record<string, any>} opts
 * @param {string} host
 */
async function once(url, opts, host) {
  await throttle(host);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
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
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ac.signal,
      headers,
      ...(opts.body ? { body: opts.body } : {}),
    });
    const body = method === 'HEAD' ? '' : await res.text();
    return { ok: res.ok, status: res.status, url: res.url, body, host };
  } catch {
    return { ok: false, status: 0, url, body: '', host };
  } finally {
    clearTimeout(timer);
  }
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
