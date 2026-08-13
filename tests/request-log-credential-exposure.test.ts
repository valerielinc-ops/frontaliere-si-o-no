/**
 * tests/request-log-credential-exposure.test.ts — #5746
 *
 * THE DEFECT. Cloud Run writes `httpRequest.requestUrl` — the whole URL, query
 * string included — for every invocation, into the `_Default` bucket that
 * anybody with `logging.viewer` can read. The four newsletter endpoints were
 * called with `?email=…&token=…`, so the log held an ADDRESS and a CREDENTIAL,
 * appaired, per request. Remeasured on 2026-08-13 over seven days: 3.131 such
 * requests, 995 distinct real addresses, across
 * newsletterManageSubscription (2.960), jobAlertUnsubscribe (163),
 * savedJobsDigestUnsubscribe (5) and outreachUnsubscribe (3).
 *
 * WHAT THIS FILE MEASURES, AND WHY IT IS THE ONLY HONEST ORACLE
 *
 * Not "does the code intend to hide the credential" — the URL string that
 * reaches `fetch()` IS the string Cloud Run logs, on both sides of the fix:
 *
 *   - the SPA calls the function directly, so the argument to `fetch` is
 *     verbatim what `httpRequest.requestUrl` will contain;
 *   - an email link is proxied by the Cloudflare Worker, so the URL of the
 *     Request the Worker hands to `fetch` is verbatim what will be logged.
 *
 * Both are asserted here by NAME (no `email=`, no `token=`) and by VALUE (the
 * address and the digest do not appear anywhere in the string), because a
 * parameter renamed to `e=` would satisfy the first check and leak exactly as
 * much.
 *
 * WHICH SHAPES A NARROWER TEST WOULD NEVER HAVE SEEN (#5764)
 *
 *  - ALL FOUR endpoints, not just the one the issue's title names. The three
 *    small ones are 5,4% of the volume and the same class of credential, and two
 *    of them are exit paths — the thing the LPD complaint was about;
 *  - every `action` in the measured table, `get_full_status` and `update_alert`
 *    included, which are not exit paths and pass unnoticed. The list is checked
 *    against `validActions` in the handler, so an action added later cannot
 *    quietly escape this file;
 *  - a link in the OLD shape, which must keep working: the parameters the
 *    upstream resolves from a stripped request are asserted EQUAL to the ones it
 *    resolved from the full query string;
 *  - a request with no `token`, and one with a token and no `email`;
 *  - the deploy-skew window, where the Worker strips and the function cannot yet
 *    read.
 *
 * Every URL here is produced by the REAL builder the senders use, never by a
 * string written in this file. That is the discipline #5767 paid for: an
 * `action=unsubscribe_all` link survived months of a regex that looked right
 * because no test ever asked the builder what it actually emits.
 *
 * Every address is on example.com — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// services/newsletterSubscribers.ts reaches Firestore at module scope for its
// other exports; none of the thirteen callers under test here touches it.
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
  setDoc: vi.fn(async () => undefined),
  addDoc: vi.fn(async () => ({ id: 'evt-1' })),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));
vi.mock('@/services/i18n', () => ({ getLocale: () => 'it' }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { PRIVATE_PARAMS_HEADER, PRIVATE_UNSUB_PARAMS, splitPrivateUnsubParams } from '../infra/cloudflare-worker/locale-router.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Cloud Functions module, no type declarations.
import { PRIVATE_PARAMS_ACK_HEADER, resolveRequestParams } from '../functions/src/lib/privateRequestParams.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS module, no type declarations.
import { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl } from '../scripts/lib/job-alert-unsub-urls.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS module, no type declarations.
import { buildUnsubUrl as buildOutreachUnsubUrl } from '../scripts/lib/outreach-unsubscribe-token.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS module, no type declarations.
import { makeOneClickUnsubscribeUrl } from '../functions/src/lib/newsletterUrls.js';
import * as subs from '@/services/newsletterSubscribers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const SECRET = 'test-secret-request-log-5746';
const EMAIL = 'lettrice@example.com';
const ALERT_ID = 'alert-abc123';
const COMPANY_KEY = 'azienda-di-prova';
const UID = 'firebase-uid-xyz';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/**
 * The saved-jobs digest link has no importable builder: its `makeUnsubscribeUrl`
 * is local to scripts/send-saved-jobs-digest.mjs, and that module reads
 * data/canton-url-slugs.json at import time — unimportable in a sparse worktree
 * by construction. So the shape is EXTRACTED from the real source instead of
 * retyped, and the extraction throws rather than degrading if the source moves:
 * a test that silently stopped covering the fourth endpoint is precisely the
 * failure #5764 is about.
 */
function savedJobsDigestUnsubUrl(uid: string, email: string, token: string): string {
  const src = read('scripts/send-saved-jobs-digest.mjs');
  const pathMatch = src.match(/const UNSUB_URL = `\$\{BASE_URL\}(\/[^`]*)`/);
  const builder = src.slice(src.indexOf('function makeUnsubscribeUrl('));
  const queryMatch = builder.match(/return `\$\{UNSUB_URL\}(\?[^`]*)`/);
  if (!pathMatch || !queryMatch) {
    throw new Error('send-saved-jobs-digest.mjs unsubscribe URL shape not found — this test must be updated, not deleted');
  }
  const query = queryMatch[1]
    .replace('${encodeURIComponent(uid)}', encodeURIComponent(uid))
    .replace('${encodeURIComponent(email)}', encodeURIComponent(email))
    .replace('${token}', token);
  if (query.includes('${')) throw new Error(`unsubstituted placeholder in extracted query: ${query}`);
  return `https://frontaliereticino.ch${pathMatch[1]}${query}`;
}

// ─── The four proxied endpoints, built by their real senders ─────────────────

type ProxiedCase = {
  endpoint: string;
  what: string;
  url: () => string;
  /** The value that must not survive into the logged URL, beyond the address. */
  credential: (url: string) => string;
  /** Parameters that MUST stay on the URL: they are what makes the log useful. */
  keeps: string[];
};

const PROXIED_CASES: ProxiedCase[] = [
  {
    endpoint: 'newsletterManageSubscription',
    what: 'the RFC 8058 one-click newsletter unsubscribe (2.960 requests)',
    url: () => makeOneClickUnsubscribeUrl(EMAIL, { secret: SECRET }),
    credential: (url) => new URL(url).searchParams.get('token') || '',
    keeps: ['action'],
  },
  {
    endpoint: 'jobAlertUnsubscribe',
    what: 'the per-alert job-alert unsubscribe (163 requests, with unsubscribe_all)',
    url: () => makeAlertUnsubscribeUrl(ALERT_ID, EMAIL),
    credential: (url) => new URL(url).searchParams.get('token') || '',
    keeps: ['alertId'],
  },
  {
    endpoint: 'jobAlertUnsubscribe',
    what: 'the "stop every job alert" link — action=unsubscribe_all, the shape #5767 found a regex blind to',
    url: () => makeAllAlertsUnsubscribeUrl(EMAIL),
    credential: (url) => new URL(url).searchParams.get('token') || '',
    keeps: ['action'],
  },
  {
    endpoint: 'savedJobsDigestUnsubscribe',
    what: 'the saved-jobs digest unsubscribe (5 requests)',
    url: () => savedJobsDigestUnsubUrl(UID, EMAIL, 'a'.repeat(64)),
    credential: (url) => new URL(url).searchParams.get('token') || '',
    keeps: ['uid'],
  },
  {
    endpoint: 'outreachUnsubscribe',
    what: 'the cold-outreach one-click unsubscribe (3 requests) — its credential is `t`, one letter long',
    url: () => buildOutreachUnsubUrl(COMPANY_KEY, SECRET),
    credential: (url) => new URL(url).searchParams.get('t') || '',
    keeps: ['c'],
  },
];

/**
 * Drive the Worker and hand back what the upstream `fetch` actually saw — the
 * URL string is, byte for byte, the `httpRequest.requestUrl` Cloud Run writes.
 */
async function proxy(
  publicUrl: string,
  init: RequestInit = {},
  upstream: (req: Request) => Response = () => new Response('page', { status: 200, headers: { [PRIVATE_PARAMS_ACK_HEADER]: '1' } }),
): Promise<{ seen: Request[]; response: Response }> {
  const seen: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(String(input));
    seen.push(req);
    return upstream(req);
  });
  const response = await worker.fetch(new Request(publicUrl, init), {}, ctx);
  return { seen, response };
}

beforeEach(() => {
  process.env.NEWSLETTER_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEWSLETTER_SECRET;
});

describe('#5746 — the credential never reaches the URL Cloud Run logs (all four endpoints)', () => {
  for (const testCase of PROXIED_CASES) {
    it(`${testCase.endpoint}: ${testCase.what}`, async () => {
      const publicUrl = testCase.url();
      const credential = testCase.credential(publicUrl);
      expect(credential, 'the real builder must actually emit a credential, or this case proves nothing').not.toBe('');

      const { seen } = await proxy(publicUrl);
      expect(seen).toHaveLength(1);
      const logged = seen[0].url;

      // By name: none of the parameters the request log must not hold.
      const loggedParams = new URL(logged).searchParams;
      for (const name of PRIVATE_UNSUB_PARAMS) {
        expect(loggedParams.has(name), `${name}= survived into the logged URL`).toBe(false);
      }
      // By value: a parameter renamed rather than removed would pass the check
      // above and leak exactly as much.
      expect(logged).not.toContain(credential);
      expect(logged).not.toContain('example.com');
      expect(logged).not.toContain(encodeURIComponent(EMAIL));
      expect(logged.toLowerCase()).not.toContain('lettrice');

      // And what the log KEEPS — a request log that cannot say which action ran
      // is a blind spot, not privacy.
      for (const kept of testCase.keeps) {
        expect(loggedParams.get(kept), `${kept}= should stay on the URL`).toBe(
          new URL(publicUrl).searchParams.get(kept),
        );
      }
      expect(seen[0].headers.get(PRIVATE_PARAMS_HEADER)).toBeTruthy();
    });
  }

  it('resolves upstream to EXACTLY the parameters the old full-query request resolved (old links keep working)', async () => {
    for (const testCase of PROXIED_CASES) {
      const publicUrl = testCase.url();
      const { seen } = await proxy(publicUrl);
      const forwarded = seen[0];

      // What the function sees now: stripped query + the header.
      const now = resolveRequestParams({
        method: 'GET',
        query: Object.fromEntries(new URL(forwarded.url).searchParams),
        headers: { [PRIVATE_PARAMS_HEADER]: forwarded.headers.get(PRIVATE_PARAMS_HEADER) },
      });
      // What it saw before this change, and still sees from any link that
      // reaches it without passing the Worker.
      const before = resolveRequestParams({
        method: 'GET',
        query: Object.fromEntries(new URL(publicUrl).searchParams),
        headers: {},
      });

      expect(now, `${testCase.endpoint}: ${testCase.what}`).toEqual(before);
      vi.restoreAllMocks();
    }
  });

  it('leaves a request carrying nothing sensitive completely alone (no header, byte-identical URL)', async () => {
    const { seen } = await proxy('https://frontaliereticino.ch/disiscrivi-alert/?alertId=only-an-id');
    expect(seen[0].url).toBe('https://europe-west6-frontaliere-ticino.cloudfunctions.net/jobAlertUnsubscribe?alertId=only-an-id');
    expect(seen[0].headers.get(PRIVATE_PARAMS_HEADER)).toBeNull();
  });

  it('is the only source of the header — a client-supplied one is dropped, not forwarded', async () => {
    const { seen } = await proxy('https://frontaliereticino.ch/disiscrivi-alert/?alertId=only-an-id', {
      headers: { [PRIVATE_PARAMS_HEADER]: 'email=someone%40example.com&token=forged' },
    });
    expect(seen[0].headers.get(PRIVATE_PARAMS_HEADER)).toBeNull();
  });

  it('carries a token with no email, and an email with no token, without inventing the other half', () => {
    const tokenOnly = splitPrivateUnsubParams(new URLSearchParams('action=unsubscribe&token=deadbeef'));
    expect(tokenOnly.privateParams.toString()).toBe('token=deadbeef');
    expect(Object.keys(resolveRequestParams({
      method: 'GET',
      query: Object.fromEntries(tokenOnly.publicParams),
      headers: { [PRIVATE_PARAMS_HEADER]: tokenOnly.privateParams.toString() },
    }))).toEqual(expect.arrayContaining(['action', 'token']));

    const emailOnly = splitPrivateUnsubParams(new URLSearchParams(`action=unsubscribe&email=${encodeURIComponent(EMAIL)}`));
    expect(emailOnly.publicParams.toString()).toBe('action=unsubscribe');
    expect(new URLSearchParams(emailOnly.privateParams.toString()).get('email')).toBe(EMAIL);
  });
});

describe('#5746 — the proxy still behaves like a proxy', () => {
  it('keeps the verb: a human GET stays a GET, so the function still renders the page instead of answering "OK"', async () => {
    const { seen } = await proxy(makeAlertUnsubscribeUrl(ALERT_ID, EMAIL));
    expect(seen[0].method).toBe('GET');
  });

  it('keeps the verb and the body of an RFC 8058 one-click POST', async () => {
    const { seen } = await proxy(makeAllAlertsUnsubscribeUrl(EMAIL), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(seen[0].method).toBe('POST');
    await expect(seen[0].text()).resolves.toBe('List-Unsubscribe=One-Click');
  });

  it('returns the upstream response untouched', async () => {
    const { response } = await proxy(
      makeAlertUnsubscribeUrl(ALERT_ID, EMAIL),
      {},
      () => new Response('<h1>Disiscritto</h1>', { status: 200, headers: { [PRIVATE_PARAMS_ACK_HEADER]: '1' } }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('<h1>Disiscritto</h1>');
  });
});

describe('#5746 — the deploy-skew window cannot break somebody\'s unsubscribe', () => {
  it('replays the legacy full-URL request when the upstream did not acknowledge the header', async () => {
    // deploy-worker.yml and deploy-cloud-functions.yml both fire on the same
    // push and finish minutes apart. In that window a stripped request answers
    // 400 (no address) or 403 (credential never arrived) — and nothing was
    // written, so replaying is free.
    const publicUrl = makeAlertUnsubscribeUrl(ALERT_ID, EMAIL);
    const { seen, response } = await proxy(publicUrl, {}, (req) =>
      req.headers.get(PRIVATE_PARAMS_HEADER)
        ? new Response('missing params', { status: 400 })
        : new Response('<h1>Disiscritto</h1>', { status: 200 }));

    expect(seen).toHaveLength(2);
    expect(seen[1].url).toContain('email=');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('<h1>Disiscritto</h1>');
  });

  it('does NOT replay once the upstream acknowledges the header — a bad credential is refused, not logged a second time', async () => {
    const { seen, response } = await proxy(
      makeAlertUnsubscribeUrl(ALERT_ID, EMAIL),
      {},
      () => new Response('link non valido', { status: 403, headers: { [PRIVATE_PARAMS_ACK_HEADER]: '1' } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).not.toContain('email=');
    expect(response.status).toBe(403);
  });

  it('does NOT replay a 5xx — a 500 may land after a write, and replaying it is how one unsubscribe becomes two', async () => {
    const { seen } = await proxy(
      makeAlertUnsubscribeUrl(ALERT_ID, EMAIL),
      {},
      () => new Response('errore', { status: 500 }),
    );
    expect(seen).toHaveLength(1);
  });
});

// ─── The SPA's own calls: ~89% of the measured volume ────────────────────────

const TOKEN = 'b'.repeat(64);

/**
 * One entry per `action` the preference centre and the autologin bridge can
 * produce. `exchange_auth_code` alone was 2.720 of the 3.131 logged pairs;
 * `get_full_status` (28) and `update_alert` (6) are in here because they are NOT
 * exit paths and are exactly the ones an "unsubscribe leak" framing walks past.
 */
const SPA_CALLS: Array<{ action: string; call: () => Promise<unknown> }> = [
  { action: 'exchange_auth_code', call: () => subs.exchangeNewsletterAuthCode(EMAIL, 'ac-code-value') },
  { action: 'unsubscribe', call: () => subs.unsubscribeViaCloudFunction(EMAIL, TOKEN) },
  { action: 'confirm', call: () => subs.confirmNewsletterSubscription(EMAIL, TOKEN) },
  { action: 'get_full_status', call: () => subs.getFullSubscriptionStatus(EMAIL, TOKEN) },
  { action: 'get_autologin_status', call: () => subs.getAutologinStatus(EMAIL, TOKEN) },
  { action: 'toggle_autologin', call: () => subs.toggleAutologin(EMAIL, TOKEN, false) },
  { action: 'revoke_autologin', call: () => subs.revokeAutologinLinks(EMAIL, TOKEN) },
  { action: 'toggle_newsletter_subscription', call: () => subs.toggleNewsletterSubscription(EMAIL, TOKEN, true) },
  { action: 'set_daily_brief_frequency', call: () => subs.setDailyBriefFrequency(EMAIL, TOKEN, 'weekly') },
  { action: 'set_advertising_opt_out', call: () => subs.setAdvertisingEnabled(EMAIL, TOKEN, false) },
  { action: 'delete_alert', call: () => subs.deleteJobAlert(EMAIL, TOKEN, ALERT_ID) },
  {
    action: 'update_alert',
    call: () => subs.updateJobAlert(EMAIL, TOKEN, ALERT_ID, { keywords: ['saldatore'], frequency: 'weekly', paused: true }),
  },
  {
    action: 'create_alert',
    call: () => subs.createJobAlert(EMAIL, TOKEN, { keywords: ['saldatore'], locations: ['Lugano'], sectors: [], frequency: 'daily' }),
  },
];

/**
 * Actions the handler accepts that no caller in this file produces, with the
 * reason. Asserted against `validActions` below so a NEW action cannot join the
 * endpoint without either getting a case here or being declared unreachable
 * from the SPA on purpose.
 */
const NOT_CALLED_FROM_THE_SPA: Record<string, string> = {
  // App.tsx handles the win-back "stay subscribed" link client-side via
  // captureNewsletterSubscriber and never calls this endpoint — see
  // tests/services/newsletterSubscribers.resubscribe.test.ts.
  resubscribe: 'reached only by an email link, never by this file',
};

describe('#5746 — the SPA puts nothing identifying on the query string', () => {
  let seen: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  for (const { action, call } of SPA_CALLS) {
    it(`action=${action}: the logged URL carries the action and nothing else about anybody`, async () => {
      await call();
      expect(seen).toHaveLength(1);
      const { url, init } = seen[0];

      // This string IS `httpRequest.requestUrl`.
      const parsed = new URL(url);
      expect(parsed.pathname.endsWith('/newsletterManageSubscription')).toBe(true);
      expect([...parsed.searchParams.keys()].sort()).toEqual(['action', 'format']);
      expect(parsed.searchParams.get('action')).toBe(action);
      expect(url).not.toContain('example.com');
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain('ac-code-value');

      // …and the credential really did travel, in the half nothing logs.
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.email).toBe(EMAIL);
      expect(body.token).toBeTruthy();
    });
  }

  it('covers every action the handler accepts, or says why not', () => {
    const src = read('functions/src/newsletterSubscriptionManagement.js');
    const match = src.match(/const validActions = \[([^\]]+)\]/);
    expect(match, 'validActions not found — this test cannot claim completeness').toBeTruthy();
    const declared = (match as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    const covered = new Set(SPA_CALLS.map((c) => c.action));
    for (const action of declared) {
      if (covered.has(action) || action in NOT_CALLED_FROM_THE_SPA) continue;
      throw new Error(`action "${action}" is accepted by the endpoint and exercised by nothing here`);
    }
  });

  it('a call with no credential never becomes a request at all', async () => {
    await expect(subs.unsubscribeViaCloudFunction(EMAIL, '')).resolves.toEqual({
      success: false,
      error: 'missing_credential',
    });
    await expect(subs.unsubscribeViaCloudFunction('', TOKEN)).resolves.toEqual({
      success: false,
      error: 'missing_credential',
    });
    expect(seen).toHaveLength(0);
  });

  it('a token with no address still leaves the address off the URL (the endpoint refuses it, the log does not learn it)', async () => {
    await subs.getFullSubscriptionStatus('', TOKEN);
    expect(seen).toHaveLength(1);
    expect([...new URL(seen[0].url).searchParams.keys()].sort()).toEqual(['action', 'format']);
    expect(JSON.parse(String(seen[0].init?.body)).email).toBe('');
  });
});

describe('#5746 — every one of the four entrypoints reads the shared resolver', () => {
  // The narrow fix this guards against is the one the issue's remeasurement
  // names: applying the change to `newsletterManageSubscription` alone and
  // leaving 173 requests on the three small endpoints exactly as they were.
  const ENTRYPOINTS = [
    'newsletterManageSubscription',
    'jobAlertUnsubscribe',
    'savedJobsDigestUnsubscribe',
    'outreachUnsubscribe',
  ];

  it('none of them still assembles params inline', () => {
    const src = read('functions/index.js');
    for (const name of ENTRYPOINTS) {
      const start = src.indexOf(`export const ${name} = onRequest`);
      expect(start, `${name} not found in functions/index.js`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 4000);
      expect(body, `${name} does not go through resolveRequestParams`).toContain('resolveRequestParams(req, res)');
      expect(body, `${name} still merges query/body inline`).not.toContain("req.method === 'GET' ? req.query");
    }
  });

  it('stamps the acknowledgement only when it actually read the header', () => {
    const withHeader: Record<string, string> = {};
    const res = { set: (k: string, v: string) => { withHeader[k] = v; } };
    resolveRequestParams({ method: 'GET', query: {}, headers: { [PRIVATE_PARAMS_HEADER]: 'email=a%40example.com' } }, res);
    expect(withHeader[PRIVATE_PARAMS_ACK_HEADER]).toBe('1');

    const without: Record<string, string> = {};
    resolveRequestParams({ method: 'GET', query: { action: 'unsubscribe' }, headers: {} }, {
      set: (k: string, v: string) => { without[k] = v; },
    });
    expect(without).toEqual({});
  });

  it('lets the query keep winning, so a request that carries nothing new resolves exactly as before', () => {
    const params = resolveRequestParams({
      method: 'POST',
      query: { email: 'query@example.com' },
      body: { token: 'from-body' },
      headers: { [PRIVATE_PARAMS_HEADER]: 'email=header%40example.com&token=from-header' },
    });
    expect(params.email).toBe('query@example.com');
    expect(params.token).toBe('from-body');
  });
});
