import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CDN_ORIGIN,
  evaluateRepairPolicy,
  evaluateProbe,
  formatIssueDescription,
  probeRuntime,
  rotationFromEnv,
  runtimeFailureFingerprint,
} from '../scripts/runtime-reliability-watch.mjs';
import { uncoveredAllowListCode } from '../scripts/ci/verify-checkout-profiles.mjs';

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

  it('does not call an authorized rollout marker blocked when no purge is needed', () => {
    const probe = evaluateProbe({
      siteCached: { body: '1789724819997', status: 200, ok: true },
      siteFresh: { body: '1789724819997', status: 200, ok: true },
      cdnMarker: { body: '1789734217605', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(probe.markerState).toBe('rollout_in_progress');
    expect(evaluateRepairPolicy({ probe })).toMatchObject({
      action: 'none',
      reason: 'no_targeted_assets',
    });
  });

  it('riapre il purge dopo il cooldown e blocca un marker che regredisce', () => {
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
    // Apex ahead of the CDN: R2 may hold an older generation than the live
    // HTML wants, so refilling the edge from it is not a repair.
    expect(mismatch.markerState).toBe('marker_regression');
    expect(evaluateRepairPolicy({ probe: mismatch }).action).toBe('blocked_marker');
    // Same verdict without any purge candidate.
    const mismatchHealthy = evaluateProbe({
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155657', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    });
    expect(evaluateRepairPolicy({ probe: mismatchHealthy }).action).toBe('blocked_marker');
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
    // R2 may be older than what the apex references (e.g. after a rollback):
    // no purge against a generation the markers do not vouch for.
    expect(result.purgeUrls).toEqual([]);
    expect(evaluateRepairPolicy({ probe: result }).action).toBe('blocked_marker');
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
    // Every asset matches R2: nothing to purge.
    expect(result.purgeUrls).toEqual([]);
    expect(result.reasons).toContain('apex behind CDN by 2.61h');
  });

  // Run 36096588819 (2026-09-25 04:58Z, rollout in progress) saw exactly this
  // for /assets/index.css and blocked the repair; seven hours later the edge
  // still served the previous object. The deploy had already purged every key
  // it re-uploaded, so R2's generation IS the intended edge state mid-rollout.
  it('keeps a stale 200 asset blocking while the CDN rollout is in progress, and purges it', () => {
    const result = evaluateProbe({
      siteCached: { body: '1700000000000', status: 200, ok: true },
      siteFresh: { body: '1700000000000', status: 200, ok: true },
      cdnMarker: { body: '1700000000001', status: 200, ok: true },
      assets: [{
        path: '/assets/index.css',
        cached: { status: 200, ok: true, bytes: 3, hash: 'old' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'new' },
      }],
    });
    // A differing hash does not prove the cached body is the generation the
    // live HTML wants, so it stays degraded until the verification is clean.
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('/assets/index.css: stale');
    expect(result.purgeUrls).toEqual([`${CDN_ORIGIN}/assets/index.css`]);
    expect(evaluateRepairPolicy({ probe: result }).action).toBe('purge');
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
    ['cached_failure', { status: 404, ok: false, bytes: 0, hash: null }, { status: 200, ok: true, bytes: 3, hash: 'new' }, [`${CDN_ORIGIN}/assets/App.js`]],
    ['fresh_failure', { status: 200, ok: true, bytes: 3, hash: 'old' }, { status: 500, ok: false, bytes: 0, hash: null }, []],
    ['unavailable', { status: 0, ok: false, bytes: 0, hash: null }, { status: 0, ok: false, bytes: 0, hash: null }, []],
  ])('stays degraded mid-rollout when a critical asset is %s', (state, cached, fresh, purgeUrls) => {
    const result = evaluateProbe({
      siteCached: { body: '1789724819997', status: 200, ok: true },
      siteFresh: { body: '1789724819997', status: 200, ok: true },
      cdnMarker: { body: '1789734217605', status: 200, ok: true },
      assets: [{ path: '/assets/App.js', cached, fresh }],
    });
    expect(result.markerState).toBe('rollout_in_progress');
    expect(result.assets[0].state).toBe(state);
    expect(result.ok).toBe(false);
    // Only a cached failure over a live R2 copy is purgeable: purging an edge
    // copy R2 no longer has would turn a working page into a 404.
    expect(result.purgeUrls).toEqual(purgeUrls);
  });

  it('compares cache-busted and stable URLs through the same fetch contract', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const isAsset = url.includes('/assets/');
      return response(isAsset ? 'asset' : '1789306155656');
    });
    const result = await probeRuntime({ fetchImpl: fetchImpl as any, now: new Date('2026-09-13T00:00:00Z'), assetPaths: ['/assets/App.js'], chunkGraph: false });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(5); // two markers + cached/fresh for one asset
    expect(calls.some((url) => url.includes('ft_reliability='))).toBe(true);
  });

  it('dispatches the watchdog after every successful Pages deploy, whatever validate-live says', () => {
    const publishWorkflow = readFileSync(
      new URL('../.github/workflows/deploy-publish.yml', import.meta.url),
      'utf8',
    );
    const job = publishWorkflow.slice(
      publishWorkflow.indexOf('  runtime-watchdog:'),
      publishWorkflow.indexOf('  report-failure:'),
    );
    expect(job).toContain('needs: [deploy, validate-dist, validate-live, publish]');
    expect(job).toMatch(/if:\s*>-\s*\n\s*\$\{\{ always\(\)/);
    expect(job).toContain("needs.deploy.result == 'success'");
    // The old gate skipped the watchdog exactly when the live site was broken.
    expect(job).not.toMatch(/needs\.validate-live\.result\s*==/);
    expect(job).toContain('actions: write  # workflow_dispatch is the explicit chained trigger');
    expect(job).toContain('gh workflow run runtime-reliability-watch.yml');
    expect(job).toContain('--ref main');
  });

  describe('runtime-reliability-watch.yml wiring', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/runtime-reliability-watch.yml', import.meta.url),
      'utf8',
    );

    it('fires on the build that uploads the CDN, not on the chained publish that never delivered', () => {
      const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
      expect(on).toMatch(/workflow_run:\s*\n\s*workflows: \["Deploy to GitHub Pages"\]/);
      expect(on).not.toMatch(/workflows: \["Publish to GitHub Pages/);
      expect(on).toContain('schedule:');
      expect(on).toContain('workflow_dispatch:');
      // Cancelled builds skip the job and must not evict a real pending check.
      expect(workflow).toContain("group: ${{ (github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success') && 'runtime-reliability-watch' || format('runtime-reliability-watch-noop-{0}', github.run_id) }}");
      expect(workflow).toMatch(/cancel-in-progress: false/);
      // A failed build may have left R2 half-uploaded: never compare or purge
      // against it on the deploy trigger (schedule/manual still run).
      expect(workflow).not.toContain("conclusion == 'failure'");
      expect(workflow).toMatch(/if: >-\s*\n\s*\$\{\{ github\.event_name != 'workflow_run' \|\|\s*\n\s*github\.event\.workflow_run\.conclusion == 'success' \}\}/);
    });

    it('purges from the report file in batches, never via one --files list or purge_everything', () => {
      expect(workflow).toContain('node scripts/runtime-reliability-watch.mjs --purge-from runtime-reliability.json');
      expect(workflow).toContain('node scripts/runtime-reliability-watch.mjs --purge-from runtime-reliability-final.json');
      expect(workflow).toContain('final_probe_retry');
      expect(workflow).not.toContain('PURGE_URLS');
      expect(workflow).not.toContain('scripts/cf-purge-cache.mjs');
      expect(workflow).not.toContain('CF_PURGE_ZONE_WIDE');
      expect(workflow).toContain('--issue-body runtime-reliability-final.json --first runtime-reliability.json');
      expect(workflow).toContain('--annotate runtime-reliability-final.json');
    });

    // The first version of this case compared import paths with the pattern
    // list as strings, so a SYMLINK counted as checked out while its target
    // was not: build-plugins/shared/articleSectionCore.mjs → packages/articles/
    // engine/shared/articleSectionCore.mjs, ERR_MODULE_NOT_FOUND on the first
    // run on main (36128534394). The generic allow-list check follows the links
    // and asks git for the match.
    it('checks out every module the watchdog loads, symlink targets included', () => {
      const block = workflow.slice(workflow.indexOf('sparse-checkout: |'), workflow.indexOf('sparse-checkout-cone-mode'));
      const patterns = block.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
      expect(patterns).toContain('packages/articles/engine/shared/articleSectionCore.mjs');
      expect(uncoveredAllowListCode(
        patterns,
        ['scripts/runtime-reliability-watch.mjs', 'scripts/load-rc-env.mjs', 'scripts/lib/github-issue-creator.mjs'],
        { cone: false },
      )).toEqual([]);
    });

    it('pins the content-sample window once per job', () => {
      expect(workflow).toContain('echo "CHUNK_GRAPH_ROTATION=$(( $(date -u +%s) / 3600 ))" >> "$GITHUB_ENV"');
      expect(workflow).toContain('probeRuntime({ chunkGraphOptions: { rotation: rotationFromEnv() } })');
      expect(rotationFromEnv({ CHUNK_GRAPH_ROTATION: '497314' }, 0)).toBe(497314);
      expect(rotationFromEnv({}, 3 * 3_600_000 + 5)).toBe(3);
      expect(rotationFromEnv({ CHUNK_GRAPH_ROTATION: 'x' }, 7_200_000)).toBe(2);
    });
  });

  describe('chunk graph in the verdict', () => {
    const coherent = {
      siteCached: { body: '1789306155656', status: 200, ok: true },
      siteFresh: { body: '1789306155656', status: 200, ok: true },
      cdnMarker: { body: '1789306155656', status: 200, ok: true },
      assets: [{
        path: '/assets/App.js',
        cached: { status: 200, ok: true, bytes: 3, hash: 'same' },
        fresh: { status: 200, ok: true, bytes: 3, hash: 'same' },
      }],
    };
    const shared = `${CDN_ORIGIN}/assets/shared-services.js`;
    const brokenGraph = {
      entries: [{ locale: 'it', kind: 'jobs', path: '/cerca-lavoro-ticino/', status: 200, derived: null }],
      chunks: [{
        url: shared,
        path: '/assets/shared-services.js',
        strong: true,
        states: { browser: 'stale', plain: 'healthy' },
        variants: { browser: { lastModified: 'Fri, 24 Jul 2026 10:00:00 GMT' }, plain: {} },
        origin: { lastModified: 'Fri, 25 Sep 2026 04:55:50 GMT' },
      }],
      broken: [{ from: `${CDN_ORIGIN}/assets/JobBoard.js`, to: shared, name: 'JOBGATE_RC_KEYS', reason: 'missing_export', variant: 'browser' }],
      families: [],
      colos: ['IAD'],
      namedImports: { browser: 218, plain: 218 },
    };

    it('turns a stale graph chunk into a failure and a purge candidate even with healthy critical assets', () => {
      const result = evaluateProbe({ ...coherent, chunkGraph: brokenGraph });
      expect(result.ok).toBe(false);
      expect(result.purgeUrls).toEqual([shared]);
      expect(result.reasons.some((r: string) => r.includes("lacks 'JOBGATE_RC_KEYS'"))).toBe(true);
      // A new graph failure must reopen the repair path.
      expect(result.fingerprint).not.toBe(evaluateProbe(coherent).fingerprint);
      const repaired = {
        ...brokenGraph,
        broken: [],
        chunks: [{ ...brokenGraph.chunks[0], states: { browser: 'healthy', plain: 'healthy' } }],
      };
      expect(evaluateProbe({ ...coherent, chunkGraph: repaired }).ok).toBe(true);
    });

    it('writes an issue body with the divergent chunk, the broken import and no zone-wide purge', () => {
      const final = evaluateProbe({ ...coherent, chunkGraph: brokenGraph });
      const body = formatIssueDescription(final, {
        first: { ...final, repair: { action: 'purge', reason: 'new_fingerprint' } },
        runUrl: 'https://github.com/o/r/actions/runs/1',
      });
      expect(body).toContain('- Run: https://github.com/o/r/actions/runs/1');
      expect(body).toContain('218 named import(s) link-checked, edge colo IAD');
      expect(body).toContain('- Repair: purge of 1 URL(s) (exact files, both cache variants) — new_fingerprint');
      expect(body).toContain('`/assets/shared-services.js` — edge: browser Fri, 24 Jul 2026 10:00:00 GMT; origin: Fri, 25 Sep 2026 04:55:50 GMT');
      expect(body).toContain('`/assets/JobBoard.js` imports `JOBGATE_RC_KEYS` from `/assets/shared-services.js`, which does not export it (browser variant)');
      expect(body).toContain('No zone-wide purge was performed.');
    });

    it('degrades instead of crashing when the walk throws', async () => {
      const fetchImpl = vi.fn(async (url: string) => response(url.includes('/assets/') ? 'asset' : '1789306155656'));
      const result = await probeRuntime({
        fetchImpl: fetchImpl as any,
        assetPaths: ['/assets/App.js'],
        // An entry list that is not a list makes the walk throw.
        chunkGraphOptions: { entryPages: null as any },
      });
      expect(result.ok).toBe(false);
      expect(result.reasons.some((r: string) => r.startsWith('chunk graph: walk failed'))).toBe(true);
    });
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
