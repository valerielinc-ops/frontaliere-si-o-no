/**
 * withProfile — la GC forzata fra due plugin si salta solo quando il plugin non
 * ha fatto crescere la memoria (PROFILE_GC_MIN_GROWTH_MB).
 *
 * Misura che motiva la soglia: deploy 39917633944, gamba IT, 98 GC forzate
 * `last-resort` su un heap vivo di 6,4-7,6 GB, 5,8-8,4 s l'una anche dopo un
 * plugin da 0,01 s (8,4 min di step). Il contratto che questi test difendono e'
 * il lato memoria: senza soglia il comportamento resta quello di prima (GC dopo
 * OGNI plugin), la prima GC gira sempre, e una crescita sopra soglia — di heap
 * O di RSS — la fa girare comunque.
 */

import type { Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  profileGcMinGrowthMb,
  resetProfileGcBaseline,
  shouldForceGcAfterPlugin,
  withProfile,
} from '../build-plugins/profilePlugin';
import { resetGcProbe } from '../build-plugins/shared/forceGc';

type GcHolder = { gc?: unknown };
const originalGc = (globalThis as GcHolder).gc;
const originalThreshold = process.env.PROFILE_GC_MIN_GROWTH_MB;
const MB = 1048576;

beforeEach(() => {
  resetProfileGcBaseline();
  resetGcProbe();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGc === undefined) delete (globalThis as GcHolder).gc;
  else (globalThis as GcHolder).gc = originalGc;
  if (originalThreshold === undefined) delete process.env.PROFILE_GC_MIN_GROWTH_MB;
  else process.env.PROFILE_GC_MIN_GROWTH_MB = originalThreshold;
  resetProfileGcBaseline();
  resetGcProbe();
});

describe('profileGcMinGrowthMb', () => {
  it('is 0 (always GC) when unset, empty, zero, negative or not a number', () => {
    for (const value of [undefined, '', '0', '-5', 'abc']) {
      expect(profileGcMinGrowthMb({ PROFILE_GC_MIN_GROWTH_MB: value } as NodeJS.ProcessEnv)).toBe(0);
    }
  });

  it('reads a positive threshold', () => {
    expect(profileGcMinGrowthMb({ PROFILE_GC_MIN_GROWTH_MB: '256' } as NodeJS.ProcessEnv)).toBe(256);
  });
});

describe('shouldForceGcAfterPlugin', () => {
  const last = { heapUsed: 6400 * MB, rss: 8400 * MB };

  it('always collects without a threshold', () => {
    expect(shouldForceGcAfterPlugin(last, last, 0)).toBe(true);
  });

  it('always collects before the first forced GC has set a baseline', () => {
    expect(shouldForceGcAfterPlugin(last, null, 256)).toBe(true);
  });

  it('skips when neither heap nor RSS grew by the threshold', () => {
    expect(shouldForceGcAfterPlugin({ heapUsed: last.heapUsed + 255 * MB, rss: last.rss + 255 * MB }, last, 256))
      .toBe(false);
  });

  it('collects when the heap grew by the threshold', () => {
    expect(shouldForceGcAfterPlugin({ heapUsed: last.heapUsed + 256 * MB, rss: last.rss }, last, 256)).toBe(true);
  });

  it('collects when RSS alone grew by the threshold (collected-but-unreturned pages)', () => {
    expect(shouldForceGcAfterPlugin({ heapUsed: last.heapUsed, rss: last.rss + 300 * MB }, last, 256)).toBe(true);
  });
});

describe('withProfile forced GC', () => {
  function wrapped(): Plugin {
    return withProfile({ name: 'tiny', closeBundle() {} } as Plugin);
  }

  async function runCloseBundle(plugin: Plugin): Promise<void> {
    const hook = plugin.closeBundle as unknown;
    if (typeof hook === 'function') await (hook as () => Promise<void>).call({});
    else await (hook as { handler: () => Promise<void> }).handler.call({});
  }

  it('keeps the previous behaviour (GC after every plugin) without a threshold', async () => {
    delete process.env.PROFILE_GC_MIN_GROWTH_MB;
    const gc = vi.fn();
    (globalThis as GcHolder).gc = gc;
    const plugin = wrapped();
    await runCloseBundle(plugin);
    await runCloseBundle(plugin);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it('runs the first GC, then skips it after a plugin that grew nothing', async () => {
    // A threshold far above anything a test process can allocate makes the
    // skip deterministic; the boundary itself is covered above.
    process.env.PROFILE_GC_MIN_GROWTH_MB = '1000000';
    const gc = vi.fn();
    (globalThis as GcHolder).gc = gc;
    const plugin = wrapped();
    await runCloseBundle(plugin);
    await runCloseBundle(plugin);
    expect(gc).toHaveBeenCalledTimes(1);
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[profile-mem]'));
    expect(lines[0]).toMatch(/ gc=forced gc_ms=\d+$/u);
    expect(lines[1]).toMatch(/ gc=skipped heap_growth_mb=-?\d+ rss_growth_mb=-?\d+$/u);
    // The parser in scripts/validate-build-profile-markers.mjs still matches.
    expect(lines[1]).toMatch(/\[profile-mem\]\s+(\S+)\s+rss_mb=(\d+)\s+heapUsed_mb=(\d+)\s+heapTotal_mb=(\d+)/u);
  });
});
