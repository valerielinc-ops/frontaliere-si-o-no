import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createJobsSourceRelayHandler,
  RELAY_MAX_UPSTREAM_PER_DAY,
  MAX_RELAY_RESPONSE_BYTES,
  verifyGithubOidcToken,
} from '../functions/src/jobsSourceRelay.js';
import { fetchSourceViaRelay } from '../scripts/lib/source-relay-fetch.mjs';

const ALLOWED_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const CHUR_URL = 'https://jobs.chur.ch/Pflegefachfrau-de-j1719.html';
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
  it('declares private IAM invocation before application authentication', () => {
    const source = readFileSync('functions/index.js', 'utf8');

    expect(source).toMatch(/export const jobsSourceRelay = onRequest\(\s*\{\s*invoker: 'private',/u);
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
