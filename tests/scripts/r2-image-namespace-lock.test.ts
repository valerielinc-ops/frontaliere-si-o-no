import { describe, expect, it } from 'vitest';
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

    expect(calls.find(({ method }) => method === 'PUT')?.headers['if-match']).toBe('expired-etag');
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
