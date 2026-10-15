import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  SECTION_ORIGIN,
  SHARD_ORIGIN,
} from '../infra/cloudflare-worker/locale-router.js';
import {
  WORKER_ORIGIN_HOSTS,
  workerOriginPurgeBatches,
  purgeWorkerOriginCache,
} from '../scripts/cf-purge-worker-origin-cache.mjs';
import { MAX_TARGETED_HOSTS } from '../scripts/lib/cf-purge-limits.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/deploy-worker.yml'), 'utf-8');

describe('Worker native origin-cache rollout purge', () => {
  it('derives every locale and section origin, without apex or CDN hosts', () => {
    const expected = [
      ...Object.values(SHARD_ORIGIN),
      ...Object.values(SECTION_ORIGIN).flatMap((origins) => Object.values(origins)),
    ].filter((host, index, hosts) => hosts.indexOf(host) === index).sort();

    expect(WORKER_ORIGIN_HOSTS).toEqual(expected);
    expect(WORKER_ORIGIN_HOSTS.length).toBeGreaterThan(3);
    expect(WORKER_ORIGIN_HOSTS.every((host) => host.startsWith('origin-'))).toBe(true);
    expect(WORKER_ORIGIN_HOSTS).not.toContain('frontaliereticino.ch');
    expect(WORKER_ORIGIN_HOSTS).not.toContain('cdn.frontaliereticino.ch');
  });

  it('sends a host-scoped purge, never a zone-wide purge', async () => {
    const purgedHosts: string[] = [];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.hosts.length).toBeGreaterThan(0);
      expect(body.hosts.length).toBeLessThanOrEqual(MAX_TARGETED_HOSTS);
      expect(body.hosts.every((host: string) => WORKER_ORIGIN_HOSTS.includes(host))).toBe(true);
      expect(body).not.toHaveProperty('purge_everything');
      purgedHosts.push(...body.hosts);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      purgeWorkerOriginCache({ token: 'test-token', zoneId: 'test-zone', fetchImpl }),
    ).resolves.toMatchObject({ zoneId: 'test-zone' });
    expect(fetchImpl).toHaveBeenCalledTimes(workerOriginPurgeBatches().length);
    expect(workerOriginPurgeBatches().every((batch) => batch.length <= MAX_TARGETED_HOSTS)).toBe(true);
    expect(purgedHosts).toEqual(WORKER_ORIGIN_HOSTS);
  });

  it('evicts a cached 503 so the first recovered GET reaches the origin', async () => {
    const staleUrl = `https://${SHARD_ORIGIN.en}/en/recovered/`;
    const nativeCache = new Map([[staleUrl, { status: 503, body: 'cached-503' }]]);
    const origin = vi.fn(async () => ({ status: 200, body: 'recovered-origin' }));

    const purgeApi = vi.fn(async (_input: string, init?: RequestInit) => {
      const { hosts } = JSON.parse(String(init?.body)) as { hosts: string[] };
      for (const key of nativeCache.keys()) {
        if (hosts.includes(new URL(key).hostname)) nativeCache.delete(key);
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await purgeWorkerOriginCache({ token: 'test-token', zoneId: 'test-zone', fetchImpl: purgeApi });

    const firstPostRolloutGet = async () => {
      const cached = nativeCache.get(staleUrl);
      if (cached) return { ...cached, source: 'native-cache' };
      const fresh = await origin();
      nativeCache.set(staleUrl, fresh);
      return { ...fresh, source: 'origin' };
    };

    await expect(firstPostRolloutGet()).resolves.toEqual({
      status: 200,
      body: 'recovered-origin',
      source: 'origin',
    });
    expect(origin).toHaveBeenCalledTimes(1);
    expect(purgeApi).toHaveBeenCalledTimes(workerOriginPurgeBatches().length);
  });

  it('runs after the Worker deploy in the rollout workflow', () => {
    const deployAt = WORKFLOW.indexOf('command: deploy');
    const purgeAt = WORKFLOW.indexOf('node scripts/cf-purge-worker-origin-cache.mjs');
    expect(deployAt).toBeGreaterThan(-1);
    expect(purgeAt).toBeGreaterThan(deployAt);
  });
});
