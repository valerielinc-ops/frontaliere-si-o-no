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

  it('fails closed without purging when the apex is ahead of the CDN', () => {
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
    // The apex serves HTML for a generation the CDN never received: the one
    // direction of skew that no rollout can explain.
    expect(result.markerState).toBe('marker_regression');
    expect(result.ok).toBe(false);
    expect(result.purgeUrls).toEqual([]);
  });

  // Production only ever shows the opposite direction: the deploy mints the CDN
  // marker in the build leg and the apex marker goes live once deploy-publish
  // has pushed the Pages artifact. Measured on 2026-09-18 across 11 watchdog
  // runs: the apex trailed the CDN by 2.61h–7.03h in all nine red runs, with
  // every critical asset healthy and zero purge candidates — so the old verdict
  // failed on a healthy rollout and offered a repair it had already blocked.
  it('treats an apex that trails the CDN as a rollout, not a degradation', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789724819997', status: 200, ok: true },
      siteFresh: { body: '1789724819997', status: 200, ok: true },
      cdnMarker: { body: '1789734217605', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(result.markerState).toBe('rollout_in_progress');
    expect(result.ok).toBe(true);
    expect(result.siteBehindMs).toBe(9_397_608);
    // Purging mid-rollout would refill the edge from the generation the live
    // HTML does not reference yet.
    expect(result.purgeUrls).toEqual([]);
    expect(result.reasons).toContain('apex behind CDN by 2.61h');
  });

  it('stays degraded mid-rollout when an asset looks stale, without purging', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789724819997', status: 200, ok: true },
      siteFresh: { body: '1789724819997', status: 200, ok: true },
      cdnMarker: { body: '1789734217605', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    // A differing hash does not prove the cached body is the generation the
    // live HTML wants, so it stays degraded — but the repair is still blocked,
    // because purging mid-rollout would refill from a generation the apex is
    // not serving yet.
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('/assets/App.js: stale');
    expect(evaluateRepairPolicy({ probe: result }).action).toBe('blocked_marker');
  });

  it('names the skew direction instead of leaning on the sign', () => {
    const regression = evaluateProbe({
      siteCached: { body: '1789734217605', status: 200, ok: true },
      siteFresh: { body: '1789734217605', status: 200, ok: true },
      cdnMarker: { body: '1789724819997', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(regression.markerState).toBe('marker_regression');
    // Never "behind by -2.61h": the direction an operator must act on is named.
    expect(regression.reasons).toContain('apex AHEAD of CDN by 2.61h');
    expect(regression.reasons.some((r: string) => r.includes('-'))).toBe(false);
  });

  it('classifies the skew direction exactly beyond 2^53', () => {
    // validBuildId accepts up to 20 digits; these two differ by 1 but are
    // indistinguishable as IEEE-754 doubles, so a Number comparison would call
    // a regression a healthy rollout.
    const result = evaluateProbe({
      siteCached: { body: '10000000000000000002', status: 200, ok: true },
      siteFresh: { body: '10000000000000000002', status: 200, ok: true },
      cdnMarker: { body: '10000000000000000001', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(Number('10000000000000000002') === Number('10000000000000000001')).toBe(true);
    expect(result.markerState).toBe('marker_regression');
    expect(result.ok).toBe(false);
  });

  it('never reports health when no asset was observed at all', () => {
    const result = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155656', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [],
    });
    expect(result.markerState).toBe('coherent');
    expect(result.ok).toBe(false);
  });

  // A rollout explains a stale edge object; it does not explain an asset that
  // is BROKEN. Without this the final probe would exit green and resolve the
  // reliability issue while a critical bundle 404s for every browser — and
  // since the coherent window is narrow by construction, that would be the
  // watchdog's normal state rather than an edge case.
  it.each([
    ['cached_failure', { status: 404, ok: false, bytes: 0, hash: null }, { status: 200, ok: true, bytes: 3, hash: 'new' }],
    ['fresh_failure', { status: 200, ok: true, bytes: 3, hash: 'old' }, { status: 500, ok: false, bytes: 0, hash: null }],
    ['unavailable', { status: 0, ok: false, bytes: 0, hash: null }, { status: 0, ok: false, bytes: 0, hash: null }],
  ])('stays degraded mid-rollout when a critical asset is %s', (state, cached, fresh) => {
    const result = evaluateProbe({
      siteCached: { body: '1789724819997', status: 200, ok: true },
      siteFresh: { body: '1789724819997', status: 200, ok: true },
      cdnMarker: { body: '1789734217605', status: 200, ok: true },
      assets: [{ path: '/assets/App.js', cached, fresh }],
    });
    expect(result.markerState).toBe('rollout_in_progress');
    expect(result.assets[0].state).toBe(state);
    expect(result.ok).toBe(false);
    // Still no blind purge against a generation the live HTML does not serve.
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
