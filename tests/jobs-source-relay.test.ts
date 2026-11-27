import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createJobsSourceRelayHandler,
  RELAY_MAX_UPSTREAM_PER_DAY,
  RELAY_TIMEOUT_MS,
  MAX_RELAY_RESPONSE_BYTES,
  parseAllowedRelayTarget,
  verifyGithubOidcToken,
} from '../functions/src/jobsSourceRelay.js';
import { fetchSourceViaRelay } from '../scripts/lib/source-relay-fetch.mjs';

const ALLOWED_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const CHUR_URL = 'https://jobs.chur.ch/Pflegefachfrau-de-j1719.html';
const ALTEN_LISTING_URL = 'https://www.alten.ch/career/jobs/';
const ALTEN_JOB_URL = 'https://www.alten.ch/jobs/903-pipe-project-manager-it/';
const RELAY_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token',
};

function request(url, { authorization = 'Bearer valid-token', method = 'GET' } = {}) {
  return {
    method,
    query: { url },
    headers: { authorization },
    get(name: string) {
      return this.headers[name.toLowerCase() as 'authorization'];
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    status(status: number) {
      this.statusCode = status;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function authenticatedHandler(fetchImpl: typeof fetch, options = {}) {
  return createJobsSourceRelayHandler({
    fetchImpl,
    verifyToken: async () => ({ repository: ALLOWED_REPOSITORY }),
    ...options,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jobsSourceRelay', () => {
  it('allows only the canonical ALTEN listing and job-detail paths', () => {
    expect(parseAllowedRelayTarget(ALTEN_LISTING_URL)).toMatchObject({
      host: 'www.alten.ch',
      path: '/career/jobs/',
    });
    expect(parseAllowedRelayTarget(ALTEN_JOB_URL)).toMatchObject({
      host: 'www.alten.ch',
      path: '/jobs/903-pipe-project-manager-it/',
    });

    for (const url of [
      'https://alten.ch/career/jobs/',
      'https://www.alten.ch/career/jobs',
      'https://www.alten.ch/career/jobs/other/',
      'https://www.alten.ch/jobs/903-pipe-project-manager-it/apply/',
      'https://www.alten.ch/jobs/not-a-source-page/',
      'http://www.alten.ch/career/jobs/',
    ]) {
      expect(parseAllowedRelayTarget(url), url).toBeNull();
    }
  });

  it('declares the CI service account as the only IAM invoker', () => {
    const source = readFileSync('functions/index.js', 'utf8');
    const generator = readFileSync('scripts/generate-crawler-group-workflows.mjs', 'utf8');
    const account = /SOURCE_RELAY_SERVICE_ACCOUNT\s*=\s*'([^']+)'/u.exec(generator)?.[1];

    expect(account).toBe('jobs-source-relay-ci@frontaliere-ticino.iam.gserviceaccount.com');
    expect(source).toContain(`SOURCE_RELAY_INVOKER_SERVICE_ACCOUNT = '${account}'`);
    // A bare 'private' makes each deploy empty the Cloud Run policy (#20279).
    expect(source).toMatch(/export const jobsSourceRelay = onRequest\(\s*\{\s*invoker: \[SOURCE_RELAY_INVOKER_SERVICE_ACCOUNT\],/u);
  });

  it('returns 403 for a host outside the allowlist', async () => {
    const fetchImpl = vi.fn();
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request('https://evil.example/Pflegefachfrau-de-j1719.html'), res);

    expect(res.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 for a path outside the allowlist', async () => {
    const fetchImpl = vi.fn();
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request('https://jobs.chur.ch/about.html'), res);

    expect(res.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a redirect to an external host', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/redirected.html' },
    }));
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request(CHUR_URL), res);

    expect(res.statusCode).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a response larger than 2 MiB', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'x'.repeat(MAX_RELAY_RESPONSE_BYTES + 1),
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request(CHUR_URL), res);

    expect(res.statusCode).toBe(413);
    expect(res.body).toContain('response_too_large');
  });

  it('cancels an invalid streamed chunk before returning an upstream error', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: '<html>' }),
      cancel,
      releaseLock,
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: { getReader: vi.fn(() => reader) },
    });
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request(CHUR_URL), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('upstream_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  }, 5_000);

  it('bounds reader cancellation triggered by the relay abort deadline', async () => {
    vi.useFakeTimers();
    try {
      let finishRead: ((result: { done: boolean }) => void) | undefined;
      const cancel = vi.fn(() => {
        finishRead?.({ done: true });
        return new Promise<void>(() => {});
      });
      const reader = {
        read: vi.fn(() => new Promise<{ done: boolean }>((resolve) => {
          finishRead = resolve;
        })),
        cancel,
        releaseLock: vi.fn(),
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: { getReader: vi.fn(() => reader) },
      });
      const handler = authenticatedHandler(fetchImpl);
      const res = responseRecorder();
      const pending = handler(request(CHUR_URL), res);

      await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(res.statusCode).toBe(504);
      expect(cancel).toHaveBeenCalled();
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it('returns 401 when the token is missing or invalid', async () => {
    const fetchImpl = vi.fn();
    const verifyToken = vi.fn(async () => {
      throw new Error('invalid');
    });
    const rateLimiter = { allow: vi.fn(() => true) };
    const dailyUpstreamCap = {
      isExhausted: vi.fn(() => false),
      tryAcquire: vi.fn(() => true),
    };
    const handler = createJobsSourceRelayHandler({ fetchImpl, verifyToken, rateLimiter, dailyUpstreamCap });
    const defaultHandler = createJobsSourceRelayHandler({ fetchImpl });
    const missing = responseRecorder();
    const invalid = responseRecorder();

    await handler(request(CHUR_URL, { authorization: '' }), missing);
    await defaultHandler(request(CHUR_URL, { authorization: 'Bearer not-a-jwt' }), invalid);

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(rateLimiter.allow).not.toHaveBeenCalled();
    expect(dailyUpstreamCap.isExhausted).not.toHaveBeenCalled();
    expect(dailyUpstreamCap.tryAcquire).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 429 daily_cap on the 401st fetch without calling upstream', async () => {
    const fetchImpl = vi.fn(async () => new Response('source body', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl, { rateLimiter: { allow: () => true } });

    try {
      for (let index = 0; index < RELAY_MAX_UPSTREAM_PER_DAY; index += 1) {
        const res = responseRecorder();
        await handler(request(CHUR_URL), res);
        expect(res.statusCode).toBe(200);
      }

      const capped = responseRecorder();
      await handler(request(CHUR_URL), capped);

      expect(capped.statusCode).toBe(429);
      expect(capped.body).toContain('daily_cap');
      expect(fetchImpl).toHaveBeenCalledTimes(RELAY_MAX_UPSTREAM_PER_DAY);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns 200 with the source body after a successful fetch', async () => {
    const sourceBody = '<html><script type="application/ld+json">{"@type":"JobPosting"}</script></html>';
    const fetchImpl = vi.fn(async () => new Response(sourceBody, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const handler = authenticatedHandler(fetchImpl);
    const res = responseRecorder();

    await handler(request(CHUR_URL), res);

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body as Buffer).toString('utf8')).toBe(sourceBody);
    expect(res.headers['content-type']).toBe('text/html');
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(CHUR_URL),
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: expect.objectContaining({ Accept: 'text/html, application/json' }),
      }),
    );
  });

  it('verifies malformed JWTs without attempting a network lookup', async () => {
    const fetchImpl = vi.fn();

    await expect(verifyGithubOidcToken('not-a-jwt', { fetchImpl })).rejects.toThrow('invalid_jwt_shape');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('source relay crawler client', () => {
  it('stays disabled when JOBS_SOURCE_RELAY_URL is unset', async () => {
    const fetchImpl = vi.fn();
    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: '',
      fetchImpl,
      env: {},
    });

    expect(response).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gets a GitHub OIDC token and sends only fixed relay headers', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('relayed source', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: RELAY_ENV,
    });

    expect(response?.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const oidcCall = fetchImpl.mock.calls[0];
    expect(String(oidcCall[0])).toContain('audience=frontaliere-jobs-source-relay');
    expect(oidcCall[1]).toMatchObject({ headers: { Authorization: 'bearer actions-request-token' } });
    const relayCall = fetchImpl.mock.calls[1];
    expect(String(relayCall[0])).toContain(`url=${encodeURIComponent(CHUR_URL)}`);
    expect(relayCall[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer github-oidc-token',
        Accept: 'text/html, application/json',
      },
    });
  });

  it.each([
    'pipelines.actions.githubusercontent.com',
    'vstoken.actions.githubusercontent.com',
  ])('accepts the GitHub Actions OIDC request host %s', async (oidcHost) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(`https://${oidcHost}/`)) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('relayed source', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: {
        ...RELAY_ENV,
        ACTIONS_ID_TOKEN_REQUEST_URL: `https://${oidcHost}/request`,
      },
    });

    expect(response?.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(oidcHost);
  });

  it.each([
    ['an unrelated host', 'https://evil.example/request'],
    ['a lookalike subdomain', 'https://evil.pipelines.actions.githubusercontent.com/request'],
    ['a non-HTTPS URL', 'http://pipelines.actions.githubusercontent.com/request'],
    ['an explicit port', 'https://pipelines.actions.githubusercontent.com:443/request'],
    ['userinfo', 'https://user@pipelines.actions.githubusercontent.com/request'],
  ])('rejects OIDC request URLs with %s', async (_description, requestUrl) => {
    const fetchImpl = vi.fn();
    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: { ...RELAY_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl },
    });

    expect(response).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds an OIDC fetch that never settles with the shared relay deadline', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const startedAt = Date.now();

    await expect(fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: { ...RELAY_ENV, JOBS_SOURCE_RELAY_TIMEOUT_MS: '25' },
    })).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('applies the same deadline to the relay fetch after OIDC succeeds', async () => {
    let relaySignal: AbortSignal | undefined;
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      relaySignal = init?.signal;
      return new Promise<Response>(() => {});
    });

    await expect(fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: { ...RELAY_ENV, JOBS_SOURCE_RELAY_TIMEOUT_MS: '25' },
    })).resolves.toBeNull();

    expect(calls).toBe(2);
    expect(relaySignal?.aborted).toBe(true);
  });

  it('bounds a relay body that never settles with the shared deadline', async () => {
    let relaySignal: AbortSignal | undefined;
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      relaySignal = init?.signal;
      return {
        status: 200,
        text: () => new Promise<string>(() => {}),
      };
    });
    const startedAt = Date.now();

    await expect(fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: { ...RELAY_ENV, JOBS_SOURCE_RELAY_TIMEOUT_MS: '25' },
    })).resolves.toBeNull();

    expect(calls).toBe(2);
    expect(relaySignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('retries only relay rate limits and succeeds on the next attempt', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fetchImpl.mock.calls.length === 2) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('relayed source', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: RELAY_ENV,
      retryDelayMs: 0,
    });

    expect(response?.status).toBe(200);
    expect(response?.text).toBe('relayed source');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caps relay rate-limit retries at three attempts', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: RELAY_ENV,
      timeoutMs: 100,
      retryDelayMs: 0,
    });

    expect(response?.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry daily_cap and returns null immediately', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'daily_cap' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: RELAY_ENV,
      retryDelayMs: 0,
    })).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry an upstream 429 that is not a relay limiter response', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('upstream throttle', {
        status: 429,
        headers: { 'content-type': 'text/html' },
      });
    });

    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env: RELAY_ENV,
      retryDelayMs: 0,
    });

    expect(response?.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers a second same-host request after the relay limiter 429', async () => {
    const upstreamFetch = vi.fn(async () => new Response('source body', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const handler = authenticatedHandler(upstreamFetch);
    const clientFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const relayRequestUrl = new URL(String(input));
      const relayResponse = responseRecorder();
      await handler(request(relayRequestUrl.searchParams.get('url') || '', {
        authorization: String((init?.headers as Record<string, string>)?.Authorization || 'Bearer relay-token'),
      }), relayResponse);
      return new Response(relayResponse.body as BodyInit, {
        status: relayResponse.statusCode,
        headers: relayResponse.headers,
      });
    });

    const first = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl: clientFetch,
      env: RELAY_ENV,
    });
    const second = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl: clientFetch,
      env: RELAY_ENV,
    });

    expect(first?.text).toBe('source body');
    expect(second?.text).toBe('source body');
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(clientFetch.mock.calls.filter(([input]) => !String(input).startsWith('https://token.actions.githubusercontent.com/'))).toHaveLength(3);
  });

  it('keeps both crawler integrations on the source-only fallback path', () => {
    const stadt = readFileSync('scripts/update-stadt-chur-jobs.mjs', 'utf8');
    const has = readFileSync('scripts/update-has-healthcare-jobs.mjs', 'utf8');
    expect(stadt).toContain('fetchSourceViaRelay(url)');
    expect(has).toContain('fetchSourceViaRelay(url)');
    expect(stadt).toContain('if (res.ok) return await res.text();');
    // Since #11133 the relay is the fallback of a failed direct fetch (WAF block
    // or connection-level error), no longer a `res.status === 403` branch.
    expect(has).toContain('if (isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status)) {');
    expect(stadt).toContain('const DETAIL_DELAY_MS = 1_000;');
    expect(has).toContain('const DETAIL_DELAY_MS = 1_000;');
    expect(has).toContain('setTimeout(r, DETAIL_DELAY_MS)');
  });
});

// #20279: the relay is also the different-egress path for the Workday CXS API
// (POST listing, GET detail), kept as narrow as the three static sources.
describe('jobsSourceRelay: Workday CXS (#20279)', () => {
  const WD_LISTING = 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs';
  const WD_DETAIL = 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/job/Zurich/Engineer_R-1';
  const LISTING_BODY = {
    appliedFacets: { locationCountry: ['187134fccb084a0ea9b4b95f23890dbe'] },
    limit: 20,
    offset: 0,
    searchText: '',
  };

  function postRequest(url: string, body: unknown) {
    return { ...request(url, { method: 'POST' }), body };
  }

  it('allows the listing as POST and the detail as GET, and nothing else on the tenant', () => {
    expect(parseAllowedRelayTarget(WD_LISTING)).toMatchObject({ methods: ['POST'], upstream: 'workday' });
    expect(parseAllowedRelayTarget(WD_DETAIL)).toMatchObject({ methods: ['GET'], upstream: 'workday' });
    for (const url of [
      'https://alcon.wd5.myworkdayjobs.com/en-US/careers_alcon',
      'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs?x=1',
      'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs#frag',
      'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/admin',
      'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/job',
      'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs/../../x',
      'https://alcon.wd5.myworkdayjobs.com:8443/wday/cxs/alcon/careers_alcon/jobs',
      'https://user@alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs',
      'http://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs',
      'https://alcon.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs',
      'https://evil.example/wday/cxs/alcon/careers_alcon/jobs',
      'https://alcon.wd5.myworkdayjobs.com.evil.example/wday/cxs/alcon/careers_alcon/jobs',
      'https://wd5.myworkdaysite.com/wday/cxs/alcon/careers_alcon/jobs',
    ]) {
      expect(parseAllowedRelayTarget(url), url).toBeNull();
    }
  });

  it('forwards a validated listing body as POST and marks the response as upstream', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ total: 1, jobPostings: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json;charset=utf-8' },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl, { rateLimiter: { allow: () => true } });
    const res = responseRecorder();

    try {
      await handler(postRequest(WD_LISTING, { ...LISTING_BODY }), res);
    } finally {
      logSpy.mockRestore();
    }

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-relay-source']).toBe('upstream');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(calledUrl)).toBe(WD_LISTING);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(String(init.body))).toEqual(LISTING_BODY);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it.each([
    ['an unknown field', { ...LISTING_BODY, extra: 1 }],
    ['an oversized limit', { ...LISTING_BODY, limit: 5000 }],
    ['a negative offset', { ...LISTING_BODY, offset: -1 }],
    ['a non-string facet value', { ...LISTING_BODY, appliedFacets: { locationCountry: [1] } }],
    ['an array body', []],
    ['an oversized searchText', { ...LISTING_BODY, searchText: 'x'.repeat(201) }],
  ])('rejects %s with 400 before any upstream call', async (_label, body) => {
    const fetchImpl = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl as unknown as typeof fetch, { rateLimiter: { allow: () => true } });
    const res = responseRecorder();
    try {
      await handler(postRequest(WD_LISTING, body), res);
    } finally {
      logSpy.mockRestore();
    }
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the method contract per target: no GET on the listing, no POST on a detail or a static source', async () => {
    const fetchImpl = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl as unknown as typeof fetch, { rateLimiter: { allow: () => true } });
    try {
      for (const req of [
        request(WD_LISTING),
        postRequest(WD_DETAIL, LISTING_BODY),
        postRequest(CHUR_URL, LISTING_BODY),
      ]) {
        const res = responseRecorder();
        await handler(req, res);
        expect(res.statusCode).toBe(405);
      }
    } finally {
      logSpy.mockRestore();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers a tenant 429 with a distinct upstream-marked 429 whatever its content type', async () => {
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl, { rateLimiter: { allow: () => true } });
    const res = responseRecorder();
    try {
      await handler(request(WD_DETAIL), res);
    } finally {
      logSpy.mockRestore();
    }
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('upstream_rate_limited');
    expect(res.headers['x-relay-source']).toBe('upstream');
  });

  it('never replays a POST against a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 307,
      headers: { location: WD_LISTING },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl, { rateLimiter: { allow: () => true } });
    const res = responseRecorder();
    try {
      await handler(postRequest(WD_LISTING, LISTING_BODY), res);
    } finally {
      logSpy.mockRestore();
    }
    expect(res.statusCode).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the Workday daily ledger separate from the three static sources', async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => new Response(
      String(input).includes('myworkdayjobs') ? '{"ok":true}' : '<html></html>',
      {
        status: 200,
        headers: { 'content-type': String(input).includes('myworkdayjobs') ? 'application/json' : 'text/html' },
      },
    ));
    const exhausted = { isExhausted: () => true, tryAcquire: () => false };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = authenticatedHandler(fetchImpl as unknown as typeof fetch, {
      rateLimiter: { allow: () => true },
      workdayDailyUpstreamCap: exhausted,
    });
    const workday = responseRecorder();
    const chur = responseRecorder();
    try {
      await handler(request(WD_DETAIL), workday);
      await handler(request(CHUR_URL), chur);
    } finally {
      logSpy.mockRestore();
    }
    expect(workday.statusCode).toBe(429);
    expect(workday.body).toContain('daily_cap');
    expect(chur.statusCode).toBe(200);
  });

  it('keeps a single relay instance so the per-host and daily ledgers stay shared (#19723 contract)', () => {
    const index = readFileSync('functions/index.js', 'utf8');
    const start = index.indexOf('export const jobsSourceRelay = onRequest(');
    const config = index.slice(start, index.indexOf('handleJobsSourceRelay', start));
    expect(config).toContain('maxInstances: 1,');
    expect(config).toContain('concurrency: 4,');
  });

  it('the client sends a POST through the relay with its body and reports an upstream response', async () => {
    const relayFetch = vi.fn(async (input: URL | string) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'oidc' }), { status: 200 });
      }
      return new Response('{"total":0}', { status: 200, headers: { 'x-relay-source': 'upstream' } });
    });
    const result = await fetchSourceViaRelay(WD_LISTING, {
      relayUrl: 'https://relay.example.run.app',
      fetchImpl: relayFetch as unknown as typeof fetch,
      env: RELAY_ENV,
      method: 'POST',
      body: JSON.stringify(LISTING_BODY),
      maxAttempts: 1,
    });
    expect(result).toEqual({ status: 200, text: '{"total":0}', upstream: true });
    const call = relayFetch.mock.calls.find(([input]) => String(input).startsWith('https://relay.example.run.app')) as unknown as [URL, RequestInit];
    expect(call[1].method).toBe('POST');
    expect(call[1].body).toBe(JSON.stringify(LISTING_BODY));
    expect((call[1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(new URL(String(call[0])).searchParams.get('url')).toBe(WD_LISTING);
  });
});

describe('source relay client: GitHub OIDC request host (#20279)', () => {
  const REAL_HOST_URL = 'https://pipelinesghubeus22.actions.githubusercontent.com/abc123/_apis/distributedtask/hubs/Actions/plans/p/jobs/j/idtoken?api-version=2.0';
  const WORKDAY_LISTING = 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs';

  it('accepts the regional runtime host of a hosted runner', async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => (
      String(input).startsWith('https://pipelinesghubeus22.')
        ? new Response(JSON.stringify({ value: 'oidc' }), { status: 200 })
        : new Response('{"ok":1}', { status: 200, headers: { 'x-relay-source': 'upstream' } })
    ));
    const result = await fetchSourceViaRelay(WORKDAY_LISTING, {
      relayUrl: 'https://relay.example.run.app',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: REAL_HOST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' },
      method: 'POST',
      body: '{}',
      maxAttempts: 1,
    });
    expect(result).toMatchObject({ status: 200, upstream: true });
  });

  it.each([
    'https://evil.example/idtoken',
    'https://actions.githubusercontent.com.evil.example/idtoken',
    'http://pipelinesghubeus22.actions.githubusercontent.com/idtoken',
    'https://user@pipelinesghubeus22.actions.githubusercontent.com/idtoken',
    'https://pipelinesghubeus22.actions.githubusercontent.com:8443/idtoken',
    'https://actions.githubusercontent.com/idtoken',
    'https://evil.pipelinesghubeus22.actions.githubusercontent.com/idtoken',
  ])('still refuses %s without sending the request token', async (requestUrl) => {
    const fetchImpl = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await fetchSourceViaRelay(WORKDAY_LISTING, {
        relayUrl: 'https://relay.example.run.app',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' },
        method: 'POST',
        body: '{}',
      });
      expect(result).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
