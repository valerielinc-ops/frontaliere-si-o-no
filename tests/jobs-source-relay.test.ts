import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createJobsSourceRelayHandler,
  MAX_RELAY_RESPONSE_BYTES,
  verifyGithubOidcToken,
} from '../functions/src/jobsSourceRelay.js';
import { fetchSourceViaRelay } from '../scripts/lib/source-relay-fetch.mjs';

const ALLOWED_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const CHUR_URL = 'https://jobs.chur.ch/Pflegefachfrau-de-j1719.html';

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

function authenticatedHandler(fetchImpl: typeof fetch) {
  return createJobsSourceRelayHandler({
    fetchImpl,
    verifyToken: async () => ({ repository: ALLOWED_REPOSITORY }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jobsSourceRelay', () => {
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
    const handler = createJobsSourceRelayHandler({ fetchImpl, verifyToken });
    const defaultHandler = createJobsSourceRelayHandler({ fetchImpl });
    const missing = responseRecorder();
    const invalid = responseRecorder();

    await handler(request(CHUR_URL, { authorization: '' }), missing);
    await defaultHandler(request(CHUR_URL, { authorization: 'Bearer not-a-jwt' }), invalid);

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token',
    };

    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: 'https://europe-west6-frontaliere.cloudfunctions.net/jobsSourceRelay',
      fetchImpl,
      env,
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

  it('keeps both crawler integrations on the source-only fallback path', () => {
    const stadt = readFileSync('scripts/update-stadt-chur-jobs.mjs', 'utf8');
    const has = readFileSync('scripts/update-has-healthcare-jobs.mjs', 'utf8');
    expect(stadt).toContain('fetchSourceViaRelay(url)');
    expect(has).toContain('fetchSourceViaRelay(url)');
    expect(stadt).toContain('if (res.ok) return await res.text();');
    expect(has).toContain('relayFallback = res.status === 403;');
  });
});
