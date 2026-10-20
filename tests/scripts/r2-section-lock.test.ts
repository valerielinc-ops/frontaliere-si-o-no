import { describe, expect, it } from 'vitest';
import {
  acquireSectionLock,
  createR2Request,
  isLockExpired,
  lockKey,
  LOCK_LEASE_MS,
  LOCK_RENEW_INITIAL_DELAY_MS,
  LOCK_RENEW_INTERVAL_MS,
  normalizeS3MatchEtag,
  parseSections,
  releaseSectionLock,
  renewSectionLock,
  renewSectionLocksUntilStopped,
} from '../../scripts/lib/r2-section-lock.mjs';
import { isCurrentPublishSource } from '../../scripts/lib/article-chunk-publish-freshness.mjs';

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
      if (headers['if-match'] && (!current || current.etag !== headers['if-match'])) return response(412);
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

  it('requests unencoded lock metadata so R2 keeps a strong ETag for CAS', async () => {
    let seen: { init: RequestInit } | undefined;
    const request = createR2Request(
      {
        R2_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_BUCKET: 'article-cdn',
        R2_ACCESS_KEY_ID: 'access-key',
        R2_SECRET_ACCESS_KEY: 'secret-key',
      },
      {
        fetchImpl: async (_url, init) => {
          seen = { init };
          return response(200, '{}', '"etag-1"');
        },
      },
    );

    await request({
      method: 'GET',
      key: lockKey('frontaliere'),
      headers: { 'Accept-Encoding': 'gzip' },
    });

    const encodingHeaders = Object.entries(seen?.init.headers ?? {})
      .filter(([name]) => name.toLowerCase() === 'accept-encoding');
    expect(encodingHeaders).toEqual([['accept-encoding', 'identity']]);
  });

  it('refuses weak S3 ETags as match conditions', () => {
    expect(normalizeS3MatchEtag(' W/"etag-1" ')).toBeUndefined();
    expect(normalizeS3MatchEtag('"etag-1"')).toBe('"etag-1"');
    expect(normalizeS3MatchEtag(undefined)).toBeUndefined();
  });

  it.each([undefined, 'W/"weak-etag"'])('does not return ownership after a section lock PUT has no strong ETag (%s)', async (etag) => {
    const { request: baseRequest, objects } = fakeR2();
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      const result = await baseRequest(input);
      if (input.method === 'PUT' && input.headers?.['if-none-match'] === '*') {
        return response(200, '', etag);
      }
      if (input.method === 'GET' && objects.has(input.key)) {
        return response(200, JSON.stringify(objects.get(input.key)?.payload), etag);
      }
      return result;
    };

    await expect(acquireSectionLock('frontaliere', {
      owner: 'owner-weak-etag',
      request,
      timeoutMs: 100,
      sleep: async () => {},
    })).rejects.toThrow('could not be confirmed with an ETag');
  });

  it('retries a conditional acquisition conflict reported as HTTP 409', async () => {
    const { request: baseRequest, objects } = fakeR2();
    let conflict = true;
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (conflict && input.method === 'PUT') {
        conflict = false;
        return response(409);
      }
      return baseRequest(input);
    };

    const lock = await acquireSectionLock('frontaliere', {
      owner: 'owner-409',
      request,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(lock.owner).toBe('owner-409');
    expect(lock.leaseId).toEqual(expect.any(String));
    expect(objects.get(lockKey('frontaliere'))?.payload.owner).toBe('owner-409');
    await releaseSectionLock('frontaliere', { owner: lock.owner, leaseId: lock.leaseId, request });
  });

  it('reconciles a committed section lock when the PUT response is ambiguous', async () => {
    const { request: baseRequest, objects } = fakeR2();
    let ambiguous = true;
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (ambiguous && input.method === 'PUT' && input.headers?.['if-none-match'] === '*') {
        ambiguous = false;
        await baseRequest(input);
        throw new Error('socket timeout after commit');
      }
      return baseRequest(input);
    };

    const lock = await acquireSectionLock('frontaliere', {
      owner: 'owner-ambiguous',
      request,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(lock).toMatchObject({ owner: 'owner-ambiguous', etag: 'etag-1' });
    expect(objects.get(lockKey('frontaliere'))?.payload.owner).toBe('owner-ambiguous');
    await releaseSectionLock('frontaliere', { owner: lock.owner, leaseId: lock.leaseId, request });
  });

  it.each([408, 500])('reconciles a section lock committed before an HTTP %s response', async (status) => {
    const { request: baseRequest, objects } = fakeR2();
    let failAfterCommit = true;
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (failAfterCommit && input.method === 'PUT' && input.headers?.['if-none-match'] === '*') {
        failAfterCommit = false;
        await baseRequest(input);
        return response(status, 'response failed after commit');
      }
      return baseRequest(input);
    };

    const lock = await acquireSectionLock('frontaliere', {
      owner: 'owner-http-500',
      request,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(lock).toMatchObject({ owner: 'owner-http-500', etag: 'etag-1' });
    expect(objects.get(lockKey('frontaliere'))?.payload.leaseId).toEqual(expect.any(String));
    await releaseSectionLock('frontaliere', { owner: lock.owner, leaseId: lock.leaseId, request });
  });

  it('recognizes a delayed section lock after retries return 409 and negative reads', async () => {
    const { request: baseRequest, objects } = fakeR2();
    const bodies: string[] = [];
    let puts = 0;
    let gets = 0;
    let pending: { key: string; body: string; headers: Record<string, string> } | undefined;
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (input.method === 'PUT' && input.headers?.['if-none-match'] === '*') {
        puts += 1;
        bodies.push(input.body ?? '');
        if (puts === 1) {
          pending = { key: input.key, body: input.body ?? '', headers: input.headers ?? {} };
          throw new Error('socket timeout while write remains pending');
        }
        if (puts === 2) return response(409);
        if (puts === 3) {
          await baseRequest({ method: 'PUT', ...pending! });
          return response(409);
        }
      }
      if (input.method === 'GET' && gets < 2) {
        gets += 1;
        return response(404);
      }
      return baseRequest(input);
    };

    const lock = await acquireSectionLock('frontaliere', {
      owner: 'owner-delayed',
      request,
      timeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(puts).toBe(3);
    expect(new Set(bodies).size).toBe(1);
    expect(lock.owner).toBe('owner-delayed');
    expect(objects.get(lockKey('frontaliere'))?.payload).toMatchObject({
      owner: 'owner-delayed',
      leaseId: expect.any(String),
    });
    await releaseSectionLock('frontaliere', { owner: lock.owner, leaseId: lock.leaseId, request });
  });

  it('does not mistake another same-owner acquisition for its ambiguous section lock', async () => {
    const { request: baseRequest, objects } = fakeR2();
    let firstPut = true;
    let secondPut = true;
    const request = async (input: Parameters<typeof baseRequest>[0]) => {
      if (input.method === 'PUT' && input.headers?.['if-none-match'] === '*') {
        if (firstPut) {
          firstPut = false;
          await baseRequest(input);
          throw new Error('first response lost after commit');
        }
        if (secondPut) {
          secondPut = false;
          await baseRequest(input);
          throw new Error('second response lost after conflict');
        }
      }
      return baseRequest(input);
    };
    const options = { owner: 'same-owner', request, now: () => 1_000, timeoutMs: 0 };

    const first = await acquireSectionLock('frontaliere', options);
    await expect(acquireSectionLock('frontaliere', options)).rejects.toThrow('timed out');
    expect(objects.get(lockKey('frontaliere'))?.payload.leaseId).toEqual(expect.any(String));
    expect(first.owner).toBe('same-owner');
    await releaseSectionLock('frontaliere', { owner: first.owner, leaseId: first.leaseId, request });
  });

  it('fences stale renew and release calls from a newer acquisition by the same owner', async () => {
    const { request, objects } = fakeR2();
    let now = 0;
    const first = await acquireSectionLock('frontaliere', {
      owner: 'same-owner',
      request,
      now: () => now,
      leaseMs: 10,
    });

    now = 11;
    const second = await acquireSectionLock('frontaliere', {
      owner: 'same-owner',
      request,
      now: () => now,
      leaseMs: 10,
      timeoutMs: 100,
      sleep: async () => {},
    });

    expect(second.leaseId).not.toBe(first.leaseId);
    expect(await renewSectionLock('frontaliere', {
      owner: first.owner,
      leaseId: first.leaseId,
      request,
      now: () => now,
    })).toBe(false);
    expect(await releaseSectionLock('frontaliere', {
      owner: first.owner,
      leaseId: first.leaseId,
      request,
    })).toBe(false);
    expect(objects.get(lockKey('frontaliere'))?.payload).toMatchObject({
      owner: second.owner,
      leaseId: second.leaseId,
    });
    await releaseSectionLock('frontaliere', {
      owner: second.owner,
      leaseId: second.leaseId,
      request,
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
      await releaseSectionLock('frontaliere', { owner, leaseId: lock.leaseId, request });
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

  it('fences an older queued checkout after a newer same-section publish', async () => {
    const { request } = fakeR2();
    const oldSha = 'a'.repeat(40);
    const newSha = 'b'.repeat(40);
    const registryBySource = new Map([
      [oldSha, ['article-old']],
      [newSha, ['article-old', 'article-new']],
    ]);
    const liveHubs = new Set(['article-old']);
    let registry = new Set(registryBySource.get(oldSha)!);

    const publish = async (owner: string, sourceSha: string, articleId: string) => {
      const lock = await acquireSectionLock('frontaliere', {
        owner,
        request,
        pollMs: 1,
        sleep: waitBriefly,
        timeoutMs: 2_000,
      });
      if (isCurrentPublishSource(sourceSha, newSha)) {
        registry = new Set(registryBySource.get(sourceSha)!);
        liveHubs.add(articleId);
      }
      await releaseSectionLock('frontaliere', { owner: lock.owner, leaseId: lock.leaseId, request });
    };

    // Force the adversarial order: the older run is already waiting while the
    // newer run publishes, then the older run acquires the same lock after it
    // has been released.
    const newRun = acquireSectionLock('frontaliere', {
      owner: 'run-new',
      request,
      pollMs: 1,
      sleep: waitBriefly,
      timeoutMs: 2_000,
    });
    const newLock = await newRun;
    const oldRun = publish('run-old', oldSha, 'article-old');
    await waitBriefly(5);
    registry = new Set(registryBySource.get(newSha)!);
    liveHubs.add('article-new');
    await releaseSectionLock('frontaliere', { owner: newLock.owner, leaseId: newLock.leaseId, request });
    await oldRun;

    expect(registry).toEqual(new Set(['article-old', 'article-new']));
    expect([...liveHubs].every((id) => registry.has(id))).toBe(true);
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
    await releaseSectionLock('svizzera', { owner: lock.owner, leaseId: lock.leaseId, request });
  });

  it('renews a long critical section so a competing owner stays blocked until release', async () => {
    const { request, objects } = fakeR2();
    let now = 0;
    const first = await acquireSectionLock('frontaliere', {
      owner: 'owner-a',
      request,
      now: () => now,
    });

    now = LOCK_LEASE_MS + 1; // past the original lease, while owner A is still publishing
    expect(await renewSectionLock('frontaliere', {
      owner: 'owner-a',
      leaseId: first.leaseId,
      request,
      now: () => now,
    })).toBe(true);
    expect(objects.get(lockKey('frontaliere'))?.payload.expiresAt).toBe(LOCK_LEASE_MS * 2 + 1);

    await expect(acquireSectionLock('frontaliere', {
      owner: 'owner-b',
      request,
      now: () => now,
      timeoutMs: 0,
    })).rejects.toThrow('timed out');

    expect(objects.get(lockKey('frontaliere'))?.payload.owner).toBe(first.owner);
    await releaseSectionLock('frontaliere', { owner: 'owner-a', leaseId: first.leaseId, request });

    const second = await acquireSectionLock('frontaliere', {
      owner: 'owner-b',
      request,
      now: () => now,
      timeoutMs: 100,
    });
    expect(second.owner).toBe('owner-b');
    await releaseSectionLock('frontaliere', { owner: 'owner-b', leaseId: second.leaseId, request });
  });

  it('waits for the initial heartbeat instead of rewriting a fresh lease immediately', async () => {
    const { request } = fakeR2();
    let requestCount = 0;
    const trackedRequest = async (args: Parameters<typeof request>[0]) => {
      requestCount += 1;
      return request(args);
    };
    const lock = await acquireSectionLock('frontaliere', { owner: 'owner-a', request: trackedRequest });
    const afterAcquire = requestCount;
    const waits: number[] = [];

    await renewSectionLocksUntilStopped(['frontaliere'], {
      owner: 'owner-a',
      leaseId: lock.leaseId,
      request: trackedRequest,
      intervalMs: 11,
      waitForStopImpl: async (duration: number) => {
        waits.push(duration);
        if (waits.length === 1) {
          expect(requestCount).toBe(afterAcquire);
          return false;
        }
        return true;
      },
    });

    expect(waits).toEqual([LOCK_RENEW_INITIAL_DELAY_MS, 11]);
    expect(requestCount).toBe(afterAcquire + 2); // GET + conditional PUT
    expect(LOCK_RENEW_INITIAL_DELAY_MS).toBe(LOCK_RENEW_INTERVAL_MS);
    await releaseSectionLock('frontaliere', { owner: 'owner-a', leaseId: lock.leaseId, request });
  });

  it('does not delete a replacement lock when ownership changes after the read', async () => {
    const { request, objects } = fakeR2();
    const first = await acquireSectionLock('frontaliere', { owner: 'owner-a', request });
    let replaced = false;
    const racingRequest = async (args: {
      method: string;
      key: string;
      body?: string;
      headers?: Record<string, string>;
    }) => {
      const result = await request(args);
      if (args.method === 'GET' && !replaced) {
        replaced = true;
        const current = objects.get(args.key)!;
        const replacement = await request({
          method: 'PUT',
          key: args.key,
          body: JSON.stringify({
            ...current.payload,
            owner: 'owner-b',
            leaseId: 'replacement-lease',
            acquiredAt: 1,
            expiresAt: 2,
          }),
          headers: { 'if-match': current.etag },
        });
        expect(replacement.status).toBe(200);
      }
      return result;
    };

    expect(await releaseSectionLock('frontaliere', {
      owner: 'owner-a',
      leaseId: first.leaseId,
      request: racingRequest,
    })).toBe(false);
    expect(objects.get(lockKey('frontaliere'))?.payload.owner).toBe('owner-b');
    await releaseSectionLock('frontaliere', { owner: 'owner-b', leaseId: 'replacement-lease', request });
  });

  it('never releases a lease owned by another run', async () => {
    const { request, objects } = fakeR2();
    const first = await acquireSectionLock('frontaliere', { owner: 'owner-a', request });

    expect(await releaseSectionLock('frontaliere', {
      owner: 'owner-b',
      leaseId: first.leaseId,
      request,
    })).toBe(false);
    expect(objects.has(lockKey('frontaliere'))).toBe(true);
    expect(isLockExpired(objects.get(lockKey('frontaliere'))?.payload)).toBe(false);
  });
});
