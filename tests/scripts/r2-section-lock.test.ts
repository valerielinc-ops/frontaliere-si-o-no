import { describe, expect, it } from 'vitest';
import {
  acquireSectionLock,
  createR2Request,
  isLockExpired,
  lockKey,
  parseSections,
  releaseSectionLock,
} from '../../scripts/lib/r2-section-lock.mjs';

type StoredLock = { payload: Record<string, unknown>; etag: string };

function response(status: number, body = '', etag?: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : undefined) },
    text: async () => body,
  };
}

function fakeR2() {
  const objects = new Map<string, StoredLock>();
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
    const current = objects.get(key);
    if (method === 'PUT') {
      if (headers['if-none-match'] === '*' && current) return response(412);
      if (headers['if-match'] && (!current || current.etag !== headers['if-match'])) return response(412);
      const etag = `etag-${++version}`;
      objects.set(key, { payload: JSON.parse(body), etag });
      return response(200, '', etag);
    }
    if (method === 'GET') {
      return current
        ? response(200, JSON.stringify(current.payload), current.etag)
        : response(404);
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return response(204);
    }
    throw new Error(`unexpected fake method: ${method}`);
  };
  return { request, objects };
}

const waitBriefly = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2)));

describe('r2-section-lock', () => {
  it('accepts only known sections and normalizes multi-section lock order', () => {
    expect(parseSections('svizzera,frontaliere,svizzera')).toEqual(['frontaliere', 'svizzera']);
    expect(lockKey('frontaliere')).toBe('internal/ci/article-chunk-locks/frontaliere.json');
    expect(() => parseSections('')).toThrow('--section');
    expect(() => parseSections('jobs')).toThrow('unknown section');
  });

  it('signs the conditional R2 PUT without adding a runtime dependency', async () => {
    let seen: { url: URL; init: RequestInit } | undefined;
    const request = createR2Request(
      {
        R2_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_BUCKET: 'article-cdn',
        R2_ACCESS_KEY_ID: 'access-key',
        R2_SECRET_ACCESS_KEY: 'secret-key',
      },
      {
        now: () => new Date('2026-09-27T09:00:00.000Z'),
        fetchImpl: async (url, init) => {
          seen = { url: new URL(String(url)), init };
          return response(200, '', 'etag-1');
        },
      },
    );

    await request({
      method: 'PUT',
      key: lockKey('frontaliere'),
      body: '{}',
      headers: { 'if-none-match': '*' },
    });

    expect(seen?.url.pathname).toBe('/article-cdn/internal/ci/article-chunk-locks/frontaliere.json');
    expect(seen?.init.headers).toMatchObject({
      'if-none-match': '*',
      'x-amz-content-sha256': expect.any(String),
      authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
    });
  });

  it('serializes concurrent same-section publishes so both hubs retain their client IDs', async () => {
    const { request } = fakeR2();
    let registry = new Set<string>();

    const publish = async (owner: string, articleId: string) => {
      const lock = await acquireSectionLock('frontaliere', {
        owner,
        request,
        pollMs: 1,
        sleep: waitBriefly,
        timeoutMs: 2_000,
      });
      // This is the lost-update shape of the production registry PUT. The
      // lock forces the second publisher to read after the first has committed.
      const snapshot = new Set(registry);
      await waitBriefly(5);
      snapshot.add(articleId);
      registry = snapshot;
      await releaseSectionLock('frontaliere', { owner, request });
      return lock;
    };

    await Promise.all([
      publish('run-old', 'article-old'),
      publish('run-new', 'article-new'),
    ]);

    expect(registry).toEqual(new Set(['article-old', 'article-new']));
    expect(registry.has('article-old')).toBe(true); // old hub hydrates
    expect(registry.has('article-new')).toBe(true); // new hub hydrates
  });

  it('takes over an expired lease with an ETag compare-and-swap', async () => {
    const { request, objects } = fakeR2();
    const now = Date.now();
    objects.set(lockKey('svizzera'), {
      etag: 'etag-stale',
      payload: {
        owner: 'dead-run',
        section: 'svizzera',
        acquiredAt: now - 2_000,
        expiresAt: now - 1,
      },
    });

    const lock = await acquireSectionLock('svizzera', {
      owner: 'replacement-run',
      request,
      now: () => now,
      timeoutMs: 100,
      sleep: waitBriefly,
    });

    expect(lock.owner).toBe('replacement-run');
    expect(objects.get(lockKey('svizzera'))?.payload.owner).toBe('replacement-run');
    await releaseSectionLock('svizzera', { owner: 'replacement-run', request });
  });

  it('never releases a lease owned by another run', async () => {
    const { request, objects } = fakeR2();
    await acquireSectionLock('frontaliere', { owner: 'owner-a', request });

    expect(await releaseSectionLock('frontaliere', { owner: 'owner-b', request })).toBe(false);
    expect(objects.has(lockKey('frontaliere'))).toBe(true);
    expect(isLockExpired(objects.get(lockKey('frontaliere'))?.payload)).toBe(false);
  });
});
