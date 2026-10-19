import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireImageNamespaceLeases,
  IMAGE_LOCK_KEY_PREFIX,
  imageNamespaceForKey,
  imageNamespaceLockKey,
  parseImageNamespaces,
  releaseImageNamespaceLeases,
  serializeImageLeaseContext,
  verifyImageNamespaceLease,
} from '../../scripts/lib/r2-image-namespace-lock.mjs';

type StoredLease = { payload: Record<string, unknown>; etag: string };
type RequestCall = {
  method: string;
  key: string;
  headers: Record<string, string>;
};

function response(status: number, body = '', etag?: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : undefined) },
    text: async () => body,
  };
}

function fakeR2() {
  const objects = new Map<string, StoredLease>();
  const calls: RequestCall[] = [];
  let version = 0;
  const request = async ({
    method,
    key,
    body = '',
    headers = {},
  }: {
    method: string;
    key: string;
    body?: string;
    headers?: Record<string, string>;
  }) => {
    calls.push({ method, key, headers });
    const current = objects.get(key);
    if (method === 'PUT') {
      if (headers['if-none-match'] === '*' && current) return response(412);
      if (headers['if-match'] && (!current || current.etag !== headers['if-match'])) return response(412);
      const etag = `image-lease-${++version}`;
      objects.set(key, { payload: JSON.parse(body), etag });
      return response(200, '', etag);
    }
    if (method === 'GET') {
      return current
        ? response(200, JSON.stringify(current.payload), current.etag)
        : response(404);
    }
    if (method === 'DELETE') {
      if (headers['if-match'] && (!current || current.etag !== headers['if-match'])) return response(412);
      objects.delete(key);
      return response(204);
    }
    throw new Error(`unexpected fake method: ${method}`);
  };
  return { request, objects, calls };
}

describe('r2-image-namespace-lock', () => {
  it('allows only blog and places prefixes and normalizes namespace order', () => {
    expect(parseImageNamespaces('places,blog,places')).toEqual(['blog', 'places']);
    expect(imageNamespaceLockKey('blog')).toBe(`${IMAGE_LOCK_KEY_PREFIX}/blog.json`);
    expect(imageNamespaceForKey('images/blog/hero.webp')).toBe('blog');
    expect(imageNamespaceForKey('images/places/lugano.webp')).toBe('places');
    expect(imageNamespaceForKey('images/blogger/hero.webp')).toBeNull();
    expect(imageNamespaceForKey('images/blog')).toBeNull();
    expect(imageNamespaceForKey('edge/frontaliere/index.html')).toBeNull();
    expect(() => parseImageNamespaces('')).toThrow('--namespace');
    expect(() => parseImageNamespaces('blog,unknown')).toThrow('unknown namespace');
  });

  it.each([
    ['acquire', ['acquire', '--namespace', 'blog', '--unexpected', 'value'], 'unexpected argument'],
    ['duplicate acquire namespace', ['acquire', '--namespace', 'blog', '--namespace', 'places'], 'duplicate argument'],
    ['verify trailing positional', ['verify', '--namespace', 'blog', '--context', '{}', 'trailing'], 'unexpected argument'],
    ['duplicate release context', ['release', '--context', '{}', '--context', '{}'], 'duplicate argument'],
  ] as const)('rejects %s before any R2 request', (_name, args, errorText) => {
    const temp = mkdtempSync(join(tmpdir(), 'image-lease-cli-args-'));
    try {
      const preload = join(temp, 'record-fetch.mjs');
      const requests = join(temp, 'requests.log');
      writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => {
  appendFileSync(process.env.STUB_FETCH_REQUESTS, 'fetch\\n');
  return { status: 500, headers: { get: () => undefined }, text: async () => 'unexpected request' };
};
`);
      const result = spawnSync(process.execPath, [
        resolve(import.meta.dirname, '../../scripts/lib/r2-image-namespace-lock.mjs'),
        ...args,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          STUB_FETCH_REQUESTS: requests,
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'test-bucket',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
        },
        timeout: 5_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(errorText);
      expect(existsSync(requests)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('acquires in stable order, verifies the owner and lease id, and releases in reverse order', async () => {
    const { request, calls, objects } = fakeR2();
    let now = 1_000;
    const leases = await acquireImageNamespaceLeases(['places', 'blog'], {
      request,
      now: () => now,
      leaseMs: 60_000,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(leases.map(({ namespace }) => namespace)).toEqual(['blog', 'places']);
    expect(calls.filter(({ method }) => method === 'PUT').map(({ key }) => key)).toEqual([
      imageNamespaceLockKey('blog'),
      imageNamespaceLockKey('places'),
    ]);
    const context = serializeImageLeaseContext(leases);
    await expect(verifyImageNamespaceLease(context, 'blog', { request, now: () => now })).resolves.toMatchObject({
      namespace: 'blog',
      owner: leases[0].owner,
      leaseId: leases[0].leaseId,
    });

    const released = await releaseImageNamespaceLeases(leases, { request, now: () => now });
    expect(released).toEqual(['places', 'blog']);
    expect(calls.filter(({ method, headers }) => method === 'PUT' && headers['if-match']).map(({ key }) => key)).toEqual([
      imageNamespaceLockKey('places'),
      imageNamespaceLockKey('blog'),
    ]);
    expect(calls.some(({ method }) => method === 'DELETE')).toBe(false);
    expect([...new Set(calls.filter(({ method }) => method === 'PUT').map(({ key }) => key))]).toEqual([
      imageNamespaceLockKey('blog'),
      imageNamespaceLockKey('places'),
    ]);
    for (const namespace of ['blog', 'places']) {
      const tombstone = objects.get(imageNamespaceLockKey(namespace))!.payload;
      expect(tombstone.releasedAt).toBe(now);
      expect(tombstone.expiresAt).toBe(now);
    }
    now += 1;
    await expect(verifyImageNamespaceLease(context, 'blog', { request, now: () => now }))
      .rejects.toThrow('no longer owned');

    const reacquired = await acquireImageNamespaceLeases(['blog'], {
      request,
      now: () => now,
      leaseMs: 60_000,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(reacquired[0].leaseId).not.toBe(leases[0].leaseId);
    expect(calls.some(({ method, key, headers }) => (
      method === 'PUT' && key === imageNamespaceLockKey('blog') && headers['if-match']
    ))).toBe(true);
  });

  it('shares one timeout across namespaces and releases the first lease if the remaining budget expires', async () => {
    const { request: baseRequest, calls, objects } = fakeR2();
    let now = 1_000;
    const placesKey = imageNamespaceLockKey('places');
    objects.set(placesKey, {
      etag: 'other-owner-etag',
      payload: {
        namespace: 'places',
        owner: 'other-owner',
        leaseId: 'other-lease',
        acquiredAt: 0,
        expiresAt: 100_000,
      },
    });
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (input.method === 'PUT'
          && input.key === imageNamespaceLockKey('blog')
          && input.headers?.['if-none-match'] === '*') {
        now += 80;
      }
      return baseRequest(input);
    };
    const sleeps: number[] = [];

    await expect(acquireImageNamespaceLeases(['blog', 'places'], {
      request,
      now: () => now,
      leaseMs: 60_000,
      timeoutMs: 100,
      pollMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    })).rejects.toThrow('timed out waiting for namespace places');

    expect(sleeps).toEqual([20]);
    expect(objects.get(imageNamespaceLockKey('blog'))?.payload).toMatchObject({
      owner: expect.any(String),
      releasedAt: now,
      expiresAt: now,
    });
    expect(objects.get(placesKey)?.payload).toMatchObject({ owner: 'other-owner', leaseId: 'other-lease' });
    expect(calls.filter(({ method, key }) => method === 'PUT' && key === placesKey)).toHaveLength(2);
    expect(calls.filter(({ method, key, headers }) => (
      method === 'PUT' && key === imageNamespaceLockKey('blog') && headers['if-match']
    ))).toHaveLength(1);
  });

  it('aborts after confirming the last namespace and rolls back every acquired lease', async () => {
    const { request: baseRequest, calls, objects } = fakeR2();
    const controller = new AbortController();
    const placesKey = imageNamespaceLockKey('places');
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      const result = await baseRequest(input);
      if (input.method === 'PUT' && input.key === placesKey
          && input.headers?.['if-none-match'] === '*' && result.status === 200) {
        controller.abort();
      }
      return result;
    };

    await expect(acquireImageNamespaceLeases(['blog', 'places'], {
      request,
      signal: controller.signal,
      timeoutMs: 1_000,
      leaseMs: 60_000,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls.filter(({ method, headers }) => method === 'PUT' && headers['if-match']).map(({ key }) => key))
      .toEqual([placesKey, imageNamespaceLockKey('blog')]);
    for (const namespace of ['blog', 'places']) {
      const payload = objects.get(imageNamespaceLockKey(namespace))?.payload;
      expect(payload).toMatchObject({ namespace, releasedAt: expect.any(Number), expiresAt: expect.any(Number) });
      expect(payload?.expiresAt).toBe(payload?.releasedAt);
    }
  });

  it('handles CLI SIGTERM while waiting for places, CAS-releases blog, and lets a later acquire succeed', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'image-lease-cli-sigterm-'));
    try {
      const preload = join(temp, 'stub-r2-fetch.mjs');
      const statePath = join(temp, 'r2-state.json');
      const requestLog = join(temp, 'requests.log');
      const now = Date.now();
      writeFileSync(statePath, JSON.stringify({
        version: 0,
        locks: {
          places: {
            etag: 'other-places-etag',
            payload: {
              namespace: 'places',
              owner: 'other-owner',
              leaseId: 'other-lease',
              acquiredAt: now - 1_000,
              expiresAt: now + 60_000,
            },
          },
        },
      }));
      writeFileSync(preload, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.STUB_R2_STATE;
const requestLog = process.env.STUB_R2_REQUEST_LOG;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const response = (status, body = '', etag) => ({
  status,
  headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : undefined },
  text: async () => body,
});
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  const namespace = pathname.endsWith('/blog.json') ? 'blog' : 'places';
  const method = options.method ?? 'GET';
  const headers = options.headers ?? {};
  const state = load();
  if (namespace === 'places' && process.env.STUB_PLACES_BUSY !== '1'
      && method === 'GET' && state.locks.places?.payload.owner === 'other-owner') {
    const releasedAt = Date.now() - 1;
    state.locks.places.payload = { ...state.locks.places.payload, releasedAt, expiresAt: releasedAt };
  }
  appendFileSync(requestLog, method + ' ' + namespace + ' ' + (headers['if-none-match'] ?? '-')
    + ' ' + (headers['if-match'] ?? '-') + '\\n');
  const current = state.locks[namespace];
  if (method === 'PUT' && headers['if-none-match'] === '*') {
    if (current) return response(412);
    const payload = JSON.parse(options.body);
    const etag = 'lease-' + (++state.version);
    state.locks[namespace] = { payload, etag };
    save(state);
    return response(200, '', etag);
  }
  if (method === 'GET') {
    save(state);
    return current ? response(200, JSON.stringify(current.payload), current.etag) : response(404);
  }
  if (method === 'PUT' && headers['if-match']) {
    if (!current || current.etag !== headers['if-match']) return response(412);
    const payload = JSON.parse(options.body);
    const etag = 'lease-' + (++state.version);
    state.locks[namespace] = { payload, etag };
    save(state);
    return response(200, '', etag);
  }
  return response(500, 'unexpected fake R2 request');
};
`);

      const cli = resolve(import.meta.dirname, '../../scripts/lib/r2-image-namespace-lock.mjs');
      const child = spawn(process.execPath, [cli, 'acquire', '--namespace', 'blog,places'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          STUB_R2_STATE: statePath,
          STUB_R2_REQUEST_LOG: requestLog,
          STUB_PLACES_BUSY: '1',
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'test-bucket',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });
      const deadline = Date.now() + 5_000;
      let reachedPlacesWait = false;
      while (Date.now() < deadline) {
        if (existsSync(requestLog) && readFileSync(requestLog, 'utf8').includes('GET places')) {
          reachedPlacesWait = true;
          break;
        }
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const termResult = await exit;
      expect(reachedPlacesWait).toBe(true);
      expect(termResult).toEqual({ code: 143, signal: null });
      expect(stderr).toContain('acquisition aborted');

      const stateAfterTerm = JSON.parse(readFileSync(statePath, 'utf8'));
      const blogAfterTerm = stateAfterTerm.locks.blog.payload;
      expect(blogAfterTerm).toMatchObject({ namespace: 'blog', releasedAt: expect.any(Number) });
      expect(blogAfterTerm.expiresAt).toBe(blogAfterTerm.releasedAt);
      expect(stateAfterTerm.locks.places.payload.owner).toBe('other-owner');
      const requestsAfterTerm = readFileSync(requestLog, 'utf8');
      expect(requestsAfterTerm).toMatch(/PUT blog \* -\n[\s\S]*PUT places \* -\n[\s\S]*PUT blog - lease-\d+/);

      const acquire = spawnSync(process.execPath, [cli, 'acquire', '--namespace', 'blog,places'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          STUB_R2_STATE: statePath,
          STUB_R2_REQUEST_LOG: requestLog,
          STUB_PLACES_BUSY: '0',
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'test-bucket',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
        },
        timeout: 5_000,
      });
      expect(acquire.status).toBe(0);
      const context = JSON.parse(acquire.stdout);
      expect(context.leases.map(({ namespace }: { namespace: string }) => namespace)).toEqual(['blog', 'places']);

      const release = spawnSync(process.execPath, [cli, 'release', '--context', JSON.stringify(context)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          STUB_R2_STATE: statePath,
          STUB_R2_REQUEST_LOG: requestLog,
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'test-bucket',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
        },
        timeout: 5_000,
      });
      expect(release.status).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('reports both the later acquire failure and an earlier lease rollback failure through the CLI', () => {
    const temp = mkdtempSync(join(tmpdir(), 'image-lease-cli-rollback-'));
    try {
      const preload = join(temp, 'stub-fetch.mjs');
      writeFileSync(preload, `
const locks = new Map();
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  const method = options.method ?? 'GET';
  const headers = options.headers ?? {};
  const blog = pathname.endsWith('/blog.json');
  const places = pathname.endsWith('/places.json');
  const response = (status, body = '', etag) => ({
    status,
    headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : undefined },
    text: async () => body,
  });

  if (method === 'PUT' && headers['if-none-match'] === '*' && blog) {
    const lease = JSON.parse(options.body);
    locks.set(pathname, lease);
    return response(200, '', 'blog-created-etag');
  }
  if (method === 'PUT' && headers['if-none-match'] === '*' && places) {
    return response(500, 'places acquisition failed');
  }
  if (method === 'GET' && blog && locks.has(pathname)) {
    return response(200, JSON.stringify(locks.get(pathname)), 'blog-created-etag');
  }
  if (method === 'PUT' && headers['if-match'] === 'blog-created-etag' && blog) {
    return response(500, 'blog rollback failed');
  }
  return response(500, 'unexpected fake R2 request');
};
`);

      const result = spawnSync(process.execPath, [
        resolve(import.meta.dirname, '../../scripts/lib/r2-image-namespace-lock.mjs'),
        'acquire',
        '--namespace',
        'blog,places',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'test-bucket',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
        },
        timeout: 5_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('acquire places failed (500): places acquisition failed');
      expect(result.stderr).toContain('release blog failed (500): blog rollback failed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails closed for an out-of-scope, stale, or replaced lease context', async () => {
    const { request, objects } = fakeR2();
    let now = 5_000;
    const leases = await acquireImageNamespaceLeases(['blog'], {
      request,
      now: () => now,
      leaseMs: 10_000,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    const context = JSON.parse(serializeImageLeaseContext(leases));

    await expect(verifyImageNamespaceLease(context, 'places', { request, now: () => now }))
      .rejects.toThrow('no current places lease');

    now += 10_000;
    await expect(verifyImageNamespaceLease(context, 'blog', { request, now: () => now }))
      .rejects.toThrow('no current blog lease');

    now = 6_000;
    const key = imageNamespaceLockKey('blog');
    const current = objects.get(key)!;
    objects.set(key, {
      etag: 'replacement-etag',
      payload: { ...current.payload, leaseId: 'different-lease-id' },
    });
    await expect(verifyImageNamespaceLease(context, 'blog', { request, now: () => now }))
      .rejects.toThrow('no longer owned');
    await expect(releaseImageNamespaceLeases(leases, { request })).resolves.toEqual([]);
    expect(objects.has(key)).toBe(true);
  });

  it('takes over only an expired lease with If-Match and leaves a replacement untouched on release', async () => {
    const { request, objects, calls } = fakeR2();
    const namespace = 'blog';
    const key = imageNamespaceLockKey(namespace);
    objects.set(key, {
      etag: 'expired-etag',
      payload: {
        namespace,
        owner: 'old-owner',
        leaseId: 'old-lease',
        acquiredAt: 100,
        expiresAt: 200,
      },
    });
    let now = 500;
    const leases = await acquireImageNamespaceLeases([namespace], {
      request,
      now: () => now,
      leaseMs: 10_000,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    const lockPuts = calls.filter(({ method, key: requestKey }) => method === 'PUT' && requestKey === key);
    expect(lockPuts).toHaveLength(2);
    expect(lockPuts[0].headers['if-none-match']).toBe('*');
    expect(lockPuts[0].headers['if-match']).toBeUndefined();
    expect(lockPuts[1].headers['if-match']).toBe('expired-etag');
    expect(lockPuts[1].headers['if-none-match']).toBeUndefined();
    const replacement = objects.get(key)!;
    objects.set(key, {
      etag: 'new-owner-etag',
      payload: { ...replacement.payload, owner: 'new-owner', leaseId: 'new-owner-lease' },
    });

    await expect(releaseImageNamespaceLeases(leases, { request })).resolves.toEqual([]);
    expect(objects.get(key)?.payload).toMatchObject({ owner: 'new-owner', leaseId: 'new-owner-lease' });
  });

  it('rejects malformed contexts before making an R2 request', async () => {
    const { request, calls } = fakeR2();
    await expect(verifyImageNamespaceLease('{"version":1,"leases":[]}', 'blog', { request }))
      .rejects.toThrow('invalid shape');
    expect(calls).toEqual([]);
  });
});
