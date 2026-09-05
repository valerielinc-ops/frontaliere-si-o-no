// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';

import {
  buildPhaseTimingPlugin,
  formatPhaseTimingReport,
  phaseTimings,
  resetPhaseTimings,
  withPhaseTiming,
} from '../build-plugins/buildPhaseTimingPlugin';

/**
 * #7303 — the OSSERVATORE of the issue: `build:ci` does not run on
 * `pull_request`, so a timing wrapper that quietly changed what a hook returns
 * (or swallowed one of its effects) would only surface on `main`, mid-deploy.
 * These tests pin transparency: measure and DELEGATE.
 */

function timings() {
  return Object.fromEntries(phaseTimings().map((t) => [`${t.plugin}:${t.hook}`, t]));
}

describe('withPhaseTiming — transparency', () => {
  beforeEach(() => {
    resetPhaseTimings();
  });

  it('returns a sync hook result as-is, without promisifying it', () => {
    const wrapped = withPhaseTiming({
      name: 'sync-plugin',
      transform: () => ({ code: 'transformed' }),
    } as unknown as Plugin);

    const out = (wrapped as unknown as { transform: () => unknown }).transform();

    expect(out).toEqual({ code: 'transformed' });
    expect(out).not.toBeInstanceOf(Promise);
    expect(timings()['sync-plugin:transform'].calls).toBe(1);
  });

  it('preserves the resolved value of an async hook', async () => {
    const wrapped = withPhaseTiming({
      name: 'async-plugin',
      closeBundle: async () => 'done',
    } as unknown as Plugin);

    await expect(
      (wrapped as unknown as { closeBundle: () => Promise<unknown> }).closeBundle(),
    ).resolves.toBe('done');
    expect(timings()['async-plugin:closeBundle'].calls).toBe(1);
  });

  it('preserves null/undefined returns (resolveId/load opt-out contract)', () => {
    const wrapped = withPhaseTiming({
      name: 'null-plugin',
      resolveId: () => null,
      load: () => undefined,
    } as unknown as Plugin);
    const w = wrapped as unknown as { resolveId: () => unknown; load: () => unknown };

    expect(w.resolveId()).toBeNull();
    expect(w.load()).toBeUndefined();
  });

  it('re-throws a sync error unchanged and still records the time', () => {
    const boom = new Error('boom');
    const wrapped = withPhaseTiming({
      name: 'throwing-plugin',
      buildStart: () => { throw boom; },
    } as unknown as Plugin);

    expect(() => (wrapped as unknown as { buildStart: () => void }).buildStart()).toThrow(boom);
    expect(timings()['throwing-plugin:buildStart'].calls).toBe(1);
  });

  it('re-rejects an async error unchanged and still records the time', async () => {
    const boom = new Error('async boom');
    const wrapped = withPhaseTiming({
      name: 'rejecting-plugin',
      generateBundle: async () => { throw boom; },
    } as unknown as Plugin);

    await expect(
      (wrapped as unknown as { generateBundle: () => Promise<void> }).generateBundle(),
    ).rejects.toBe(boom);
    expect(timings()['rejecting-plugin:generateBundle'].calls).toBe(1);
  });

  it('forwards arguments and the Rollup plugin context (`this`)', async () => {
    const seen: unknown[] = [];
    const wrapped = withPhaseTiming({
      name: 'ctx-plugin',
      transform(this: unknown, code: string, id: string) {
        seen.push(this, code, id);
        return null;
      },
    } as unknown as Plugin);

    const ctx = { emitFile: () => 'ref' };
    (wrapped as unknown as { transform: (c: string, i: string) => unknown })
      .transform.call(ctx, 'src', '/a.ts');

    expect(seen).toEqual([ctx, 'src', '/a.ts']);
  });

  it('keeps the ObjectHook siblings that drive execution order', () => {
    const wrapped = withPhaseTiming({
      name: 'object-hook-plugin',
      closeBundle: { order: 'post', sequential: true, handler: () => 'v' },
    } as unknown as Plugin);
    const hook = (wrapped as unknown as {
      closeBundle: { order: string; sequential: boolean; handler: () => unknown };
    }).closeBundle;

    expect(hook.order).toBe('post');
    expect(hook.sequential).toBe(true);
    expect(hook.handler()).toBe('v');
  });

  it('leaves a plugin with no timed hook strictly identical', () => {
    const plugin = { name: 'inert', config: () => ({}) } as unknown as Plugin;
    expect(withPhaseTiming(plugin)).toBe(plugin);
  });

  it('preserves every other plugin property (enforce, apply)', () => {
    const wrapped = withPhaseTiming({
      name: 'enforced',
      enforce: 'pre',
      apply: 'build',
      transform: () => null,
    } as unknown as Plugin);

    expect(wrapped.enforce).toBe('pre');
    expect(wrapped.apply).toBe('build');
  });

  it('accumulates ms and calls across repeated invocations', () => {
    const wrapped = withPhaseTiming({
      name: 'hot',
      transform: () => null,
    } as unknown as Plugin);
    const t = (wrapped as unknown as { transform: () => unknown }).transform;

    t(); t(); t();

    expect(timings()['hot:transform'].calls).toBe(3);
    expect(timings()['hot:transform'].ms).toBeGreaterThanOrEqual(0);
  });
});

describe('formatPhaseTimingReport', () => {
  it('orders pairs by cost and reports the per-hook rollup and the total', () => {
    const lines = formatPhaseTimingReport(
      [
        { plugin: 'cheap', hook: 'transform', ms: 100, calls: 5 },
        { plugin: 'expensive', hook: 'closeBundle', ms: 900, calls: 1 },
      ] as never,
      2000,
      2500,
    );

    const pairLines = lines.filter((l) => l.startsWith('[phase-timing] '));
    expect(pairLines[0]).toContain('expensive:closeBundle');
    expect(pairLines[0]).toContain('900ms calls=1');
    expect(pairLines[1]).toContain('cheap:transform');

    expect(lines).toContainEqual(expect.stringContaining('[phase-timing-top]  1. expensive:closeBundle'));
    expect(lines.filter((l) => l.startsWith('[phase-timing-hook]'))).toHaveLength(2);

    const total = lines.at(-1)!;
    expect(total).toContain('measured=1.00s');
    expect(total).toContain('build_wall=2.00s');
    expect(total).toContain('unattributed=1.00s');
    expect(total).toContain('pairs=2');
  });

  it('names parallel overlap instead of printing a negative remainder', () => {
    const total = formatPhaseTimingReport(
      [{ plugin: 'a', hook: 'closeBundle', ms: 3000, calls: 1 }] as never,
      1000,
      1200,
    ).at(-1)!;

    expect(total).toContain('parallel-overlap=2.00s');
    expect(total).not.toContain('unattributed=-');
  });

  it('emits no NaN percentage when nothing was measured', () => {
    const lines = formatPhaseTimingReport([], 1000, 1200);
    expect(lines.join('\n')).not.toContain('NaN');
  });

  it('caps the ordered recap at topN', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      plugin: `p${i}`, hook: 'closeBundle', ms: i, calls: 1,
    }));
    const lines = formatPhaseTimingReport(entries as never, 1000, 1200, 5);
    expect(lines.filter((l) => l.startsWith('[phase-timing-top]'))).toHaveLength(5);
  });
});

describe('buildPhaseTimingPlugin', () => {
  beforeEach(() => {
    resetPhaseTimings();
  });

  it('runs strictly last: enforce post + closeBundle order post + sequential', () => {
    const plugin = buildPhaseTimingPlugin();
    const hook = plugin.closeBundle as { order: string; sequential: boolean };

    expect(plugin.name).toBe('build-phase-timing');
    expect(plugin.enforce).toBe('post');
    expect(plugin.apply).toBe('build');
    expect(hook.order).toBe('post');
    expect(hook.sequential).toBe(true);
  });

  it('prints the report and leaves the `[profile]` line format alone', () => {
    const wrapped = withPhaseTiming({
      name: 'measured',
      closeBundle: () => undefined,
    } as unknown as Plugin);
    (wrapped as unknown as { closeBundle: () => unknown }).closeBundle();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const plugin = buildPhaseTimingPlugin();
      (plugin.buildStart as { handler: () => void }).handler();
      (plugin.closeBundle as { handler: () => void }).handler();
    } finally {
      log.mockRestore();
    }

    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed.some((l) => l.startsWith('[phase-timing] measured:closeBundle'))).toBe(true);
    expect(printed.some((l) => l.startsWith('[phase-timing-total]'))).toBe(true);
    expect(printed.some((l) => l.startsWith('[profile]'))).toBe(false);
  });
});
