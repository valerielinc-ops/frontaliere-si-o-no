import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CDN_ORIGIN,
  evaluateRepairPolicy,
  evaluateProbe,
  probeRuntime,
  runtimeFailureFingerprint,
} from '../scripts/runtime-reliability-watch.mjs';

function response(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

describe('runtime reliability watchdog', () => {
  it('allows a coherent marker pair when every critical asset is fresh', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true, bytes: 13, hash: 'site' },
      siteFresh: { body: '1789306155656', status: 200, ok: true, bytes: 13, hash: 'site' },
      cdnMarker: { body: '1789306155656', status: 200, ok: true, bytes: 13, hash: 'cdn' },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(result).toMatchObject({ ok: true, markerState: 'coherent', purgeUrls: [] });
  });

  it('returns only stale CDN asset URLs for a targeted repair', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155656', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [
        {
          path: '/assets/App.js',
          cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
          fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
        },
        {
          path: '/assets/index.css',
          cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
          fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.purgeUrls).toEqual([`${CDN_ORIGIN}/assets/App.js`]);
  });

  it('deduplicates the same divergence during the repair cooldown', () => {
    const probe = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155656', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    const at = Date.parse('2026-09-13T00:00:00Z');
    const policy = evaluateRepairPolicy({
      probe,
      previousState: { fingerprint: probe.fingerprint, lastActionAt: new Date(at - 60_000).toISOString() },
      nowMs: at,
    });
    expect(policy).toMatchObject({ action: 'skip_duplicate_purge', circuit: 'open' });
    expect(runtimeFailureFingerprint(probe)).toBe(probe.fingerprint);
  });

  it('riapre il purge dopo il cooldown e blocca un marker non coerente', () => {
    const stale = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155656', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    const at = Date.parse('2026-09-13T00:00:00Z');
    expect(evaluateRepairPolicy({
      probe: stale,
      previousState: { fingerprint: stale.fingerprint, lastActionAt: new Date(at - 16 * 60_000).toISOString() },
      nowMs: at,
    }).action).toBe('purge');
    const mismatch = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155657', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    expect(evaluateRepairPolicy({ probe: mismatch }).action).toBe('blocked_marker');
  });

  it('fails closed without purging while markers disagree', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155657', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    expect(result.markerState).toBe('marker_mismatch');
    expect(result.purgeUrls).toEqual([]);
  });

  it('compares cache-busted and stable URLs through the same fetch contract', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const isAsset = url.includes('/assets/');
      return response(isAsset ? 'asset' : '1789306155656');
    });
    const result = await probeRuntime({ fetchImpl: fetchImpl as any, now: new Date('2026-09-13T00:00:00Z'), assetPaths: ['/assets/App.js'] });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(5); // two markers + cached/fresh for one asset
    expect(calls.some((url) => url.includes('ft_reliability='))).toBe(true);
  });

  it('dispatches an immediate watchdog after a completed Pages/live publish tail', () => {
    const publishWorkflow = readFileSync(
      new URL('../.github/workflows/deploy-publish.yml', import.meta.url),
      'utf8',
    );
    expect(publishWorkflow).toContain('runtime-watchdog:');
    expect(publishWorkflow).toContain('needs: [deploy, validate-dist, validate-live, publish]');
    expect(publishWorkflow).toMatch(/if:\s*>-\s*\n\s*\$\{\{ always\(\)/);
    expect(publishWorkflow).toContain('actions: write  # workflow_dispatch is the explicit chained trigger');
    expect(publishWorkflow).toContain('gh workflow run runtime-reliability-watch.yml');
    expect(publishWorkflow).toContain('--ref main');
  });

  it('retains the cooldown timestamp when a duplicate purge is skipped', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/runtime-reliability-watch.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('const sameFingerprint = Boolean(fingerprint) && previous.fingerprint === fingerprint;');
    expect(workflow).toContain('&& first.fingerprint === fingerprint');
    expect(workflow).toContain("&& first.repair?.action === 'purge'");
    expect(workflow).toContain(': sameFingerprint ? previousLastActionAt : null,');
    expect(workflow).toContain("!Array.isArray(candidate)");
  });
});
