import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import { withBuildStopAfter } from '../build-plugins/buildStopAfterPlugin';

const previousStopAfter = process.env.BUILD_STOP_AFTER;

afterEach(() => {
  if (previousStopAfter === undefined) delete process.env.BUILD_STOP_AFTER;
  else process.env.BUILD_STOP_AFTER = previousStopAfter;
  vi.restoreAllMocks();
});

describe('BUILD_STOP_AFTER closeBundle gate', () => {
  it('does not alter a plugin when the opt-in is absent', () => {
    delete process.env.BUILD_STOP_AFTER;
    const plugin = { name: 'jobs-seo-pages', closeBundle: () => 'done' } as unknown as Plugin;
    expect(withBuildStopAfter(plugin)).toBe(plugin);
  });

  it('accepts jobsSeoPages, waits for the hook, logs, and exits with code 0', async () => {
    process.env.BUILD_STOP_AFTER = 'jobsSeoPages';
    const events: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const plugin = withBuildStopAfter({
      name: 'jobs-seo-pages',
      closeBundle: async function (this: unknown, marker: string) {
        expect(this).toBe(context);
        events.push(`started:${marker}`);
        await Promise.resolve();
        events.push('completed');
        return 'result';
      },
    } as unknown as Plugin, (code) => events.push(`exit:${code}`));
    const context = {};
    const hook = plugin.closeBundle as { sequential: boolean; handler: (...args: unknown[]) => Promise<unknown> };

    expect(hook.sequential).toBe(true);
    await expect(hook.handler.call(context, 'flush-complete')).resolves.toBe('result');
    expect(events).toEqual(['started:flush-complete', 'completed', 'exit:0']);
    expect(log).toHaveBeenCalledWith(
      '[build-stop-after] jobsSeoPages completed, exiting (BUILD_STOP_AFTER)',
    );
  });

  it('preserves ObjectHook ordering metadata while forcing a stop barrier', async () => {
    process.env.BUILD_STOP_AFTER = 'jobs-seo-pages';
    const filter = () => true;
    const exits: number[] = [];
    const plugin = withBuildStopAfter({
      name: 'jobs-seo-pages',
      closeBundle: {
        order: 'post' as const,
        sequential: false,
        filter,
        handler: () => 'object-hook-result',
      },
    } as unknown as Plugin, (code) => exits.push(code ?? -1));
    const hook = plugin.closeBundle as {
      order: 'post';
      sequential: boolean;
      filter: typeof filter;
      handler: () => Promise<unknown>;
    };

    expect(hook.order).toBe('post');
    expect(hook.filter).toBe(filter);
    expect(hook.sequential).toBe(true);
    await expect(hook.handler()).resolves.toBe('object-hook-result');
    expect(exits).toEqual([0]);
  });

  it('leaves a non-matching plugin untouched', () => {
    process.env.BUILD_STOP_AFTER = 'jobsSeoPages';
    const plugin = { name: 'job-sector-pages', closeBundle: () => 'done' } as unknown as Plugin;
    expect(withBuildStopAfter(plugin)).toBe(plugin);
  });
});
