import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Dispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, resolveCompanyWebsite, resolveCompanyWebsites, run } from '../scripts/resolve-company-website.mjs';

type ResolverHeaders = { get(name: string): string | null };
type ResolverBody = { cancel(): Promise<unknown> };
type ResolverResponse = {
  ok: boolean;
  status: number;
  url?: string;
  headers: ResolverHeaders;
  body: ResolverBody | null;
};
type ResolverRequestInit = {
  method?: 'HEAD' | 'GET';
  redirect?: 'manual';
  signal?: AbortSignal;
  headers?: Record<string, string>;
  dispatcher?: Dispatcher;
};
type ResolverLookupOptions = { all: true; verbatim: true };
type ResolverLookupRecord = { address: string; family: number };

const PUBLIC_DNS = async (
  _hostname: string,
  _options: ResolverLookupOptions,
): Promise<ResolverLookupRecord[]> => [{ address: '93.184.216.34', family: 4 }];

function response(
  status = 200,
  location: string | null = null,
  cancel = vi.fn().mockResolvedValue(undefined),
  url = '',
): ResolverResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
    body: { cancel },
    url,
  };
}

describe('company website resolver', () => {
  it('normalizes a website to its registrable lookup domain', () => {
    expect(normalizeDomain('https://WWW.Example.CH/careers')).toBe('example.ch');
    expect(normalizeDomain('mailto:jobs@example.ch')).toBeNull();
  });

  it('follows bounded manual HTTPS redirects, including a public cross-domain destination', async () => {
    const lookupImpl = vi.fn(PUBLIC_DNS);
    const fetchImpl = vi.fn(async (input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      new URL(input).hostname.endsWith('example.ch')
        ? response(301, 'https://careers.example.net/jobs')
        : response()
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl })).resolves
      .toBe('https://careers.example.net/jobs');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    expect(lookupImpl.mock.calls.map(([hostname]) => hostname).sort()).toEqual([
      'careers.example.net',
      'careers.example.net',
      'example.ch',
      'www.example.ch',
    ]);
  });

  it('preserves one valid winner when the other host variant is unavailable', async () => {
    const fetchImpl = vi.fn(async (input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      new URL(input).hostname.startsWith('www.') ? response() : response(404)
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves
      .toBe('https://www.example.ch/');
  });

  it('fails closed only when two valid winners diverge', async () => {
    const fetchImpl = vi.fn(async (input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => {
      const url = new URL(input);
      if (url.hostname === 'example.ch') return response(301, 'https://careers-a.example.net/');
      if (url.hostname === 'www.example.ch') return response(301, 'https://careers-b.example.net/');
      return response();
    });
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves.toBeNull();
  });

  it('falls back to GET only when HEAD is unsupported and cancels every response body', async () => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const fetchImpl = vi.fn(async (input: string, init: ResolverRequestInit): Promise<ResolverResponse> => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      cancels.push(cancel);
      const status = init?.method === 'HEAD'
        ? 405
        : new URL(input).hostname.startsWith('www.') ? 404 : 200;
      return response(status, null, cancel);
    });
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves
      .toBe('https://example.ch/');
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'HEAD', 'GET', 'GET']);
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it('fails closed for a network error', async () => {
    const networkError = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => {
      throw new Error('network failure');
    });
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl: networkError, lookupImpl: PUBLIC_DNS }))
      .resolves.toBeNull();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.8',
    '172.16.0.8',
    '192.168.0.8',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public DNS address %s before issuing a request', async (address) => {
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => response());
    const lookupImpl = vi.fn(async (
      _hostname: string,
      _options: ResolverLookupOptions,
    ): Promise<ResolverLookupRecord[]> => [{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects the metadata hostname on a redirect before issuing the unsafe request', async () => {
    const redirectFetch = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      response(302, 'https://metadata.google.internal/computeMetadata/v1/')
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl: redirectFetch, lookupImpl: PUBLIC_DNS }))
      .resolves.toBeNull();
    expect(redirectFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an unsafe effective URL reported by the transport', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      response(200, null, vi.fn().mockResolvedValue(undefined), 'https://127.0.0.1/admin')
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves.toBeNull();
  });

  it('rejects a redirect that downgrades HTTPS instead of rewriting its scheme', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      response(301, 'http://public.example.net/')
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops redirect loops after the fixed hop budget', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => (
      response(301, 'https://redirect.example.net/')
    ));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl, lookupImpl: PUBLIC_DNS })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it('settles a genuinely pending fetch only when its AbortSignal fires', async () => {
    const aborted: AbortSignal[] = [];
    const fetchImpl = vi.fn((_input: string, init: ResolverRequestInit) => new Promise<ResolverResponse>((_resolve, reject) => {
      const signal = init.signal;
      signal.addEventListener('abort', () => {
        aborted.push(signal);
        reject(signal.reason);
      }, { once: true });
    }));
    await expect(resolveCompanyWebsite('example.ch', {
      fetchImpl,
      lookupImpl: PUBLIC_DNS,
      timeoutMs: 5,
    })).resolves.toBeNull();
    expect(aborted).toHaveLength(2);
    expect(aborted.every((signal) => signal.aborted)).toBe(true);
  });

  it('fails closed within the real budget when DNS lookup never settles', async () => {
    const lookupImpl = vi.fn((_hostname: string, _options: ResolverLookupOptions) => new Promise<ResolverLookupRecord[]>(() => {}));
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => response());
    const startedAt = Date.now();
    await expect(resolveCompanyWebsite('example.ch', {
      fetchImpl,
      lookupImpl,
      timeoutMs: 10,
    })).resolves.toBeNull();
    const elapsedMs = Date.now() - startedAt;
    expect(lookupImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(elapsedMs).toBeGreaterThanOrEqual(5);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('produces a sorted, duplicate-free registry through a low deterministic pool', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return response();
    });
    const companies = Array.from({ length: 8 }, (_, index) => ({ website: `https://company-${7 - index}.example/` }));
    const resolved = await resolveCompanyWebsites([
      ...companies,
      { website: 'https://company-0.example/jobs' },
      { website: 'not a url' },
    ], { fetchImpl, lookupImpl: PUBLIC_DNS, concurrency: 2 });
    expect(Object.keys(resolved)).toEqual(Array.from({ length: 8 }, (_, index) => `company-${index}.example`));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('wires the dispatcher and rejects a private second DNS answer at socket connect time', async () => {
    const lookupCounts = new Map<string, number>();
    const lookupImpl = vi.fn(async (
      hostname: string,
      _options: ResolverLookupOptions,
    ): Promise<ResolverLookupRecord[]> => {
      const count = (lookupCounts.get(hostname) ?? 0) + 1;
      lookupCounts.set(hostname, count);
      return [{ address: count === 1 ? '93.184.216.34' : '10.0.0.8', family: 4 }];
    });

    await expect(resolveCompanyWebsite('rebind.invalid', { lookupImpl, timeoutMs: 100 })).resolves.toBeNull();
    expect(lookupCounts.get('rebind.invalid')).toBe(2);
    expect(lookupCounts.get('www.rebind.invalid')).toBe(2);
  });

  it('does not rewrite an unchanged registry and preserves its mtime', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'company-website-resolver-'));
    try {
      const inputPath = path.join(root, 'companies.json');
      const outputPath = path.join(root, 'resolved.json');
      writeFileSync(inputPath, JSON.stringify([{ website: 'https://example.ch' }]));
      const fetchImpl = vi.fn(async (_input: string, _init: ResolverRequestInit): Promise<ResolverResponse> => response());
      const first = await run({ inputPath, outputPath, fetchImpl, lookupImpl: PUBLIC_DNS });
      const firstContents = readFileSync(outputPath, 'utf8');
      const stableTime = new Date('2020-01-01T00:00:00.000Z');
      utimesSync(outputPath, stableTime, stableTime);
      const before = statSync(outputPath).mtimeMs;
      const second = await run({ inputPath, outputPath, fetchImpl, lookupImpl: PUBLIC_DNS });
      expect(second).toEqual(first);
      expect(readFileSync(outputPath, 'utf8')).toBe(firstContents);
      expect(statSync(outputPath).mtimeMs).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the ratified source and first probe registry complete and schema-valid', () => {
    const companies = JSON.parse(readFileSync(path.resolve('data/crawler-companies-auto.json'), 'utf8'));
    const registry = JSON.parse(readFileSync(path.resolve('data/company-website-resolved.json'), 'utf8'));
    expect(companies).toHaveLength(592);
    expect(registry.schemaVersion).toBe(1);
    expect(Object.keys(registry.domains)).toHaveLength(22);
    expect(Object.values(registry.domains).every((value) => value === null || /^https:\/\//.test(String(value))))
      .toBe(true);
  });
});
