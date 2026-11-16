import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';

import { localeJobsSplitPlugin } from '../build-plugins/localeJobsSplitPlugin';
import { clearJobCanonOrderingFields } from '../build-plugins/shared/jobCanonInputs';
import {
  _resetLocaleJobsSplitSignalForTests,
  localeJobsSplitFlushed,
  shouldAwaitLocaleJobsSplitFlushed,
} from '../build-plugins/shared/buildSignals';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-jobs-split-barrier-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), '[]');
  return root;
}

afterEach(() => {
  _resetLocaleJobsSplitSignalForTests();
  clearJobCanonOrderingFields();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function closeSplit(plugin: ReturnType<typeof localeJobsSplitPlugin>): void {
  const handoffPath = process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
  delete process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
  try {
    (plugin.closeBundle as () => void)();
  } finally {
    if (handoffPath === undefined) delete process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
    else process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH = handoffPath;
  }
}

describe('locale job split completion barrier', () => {
  it('is disabled when the producer is omitted or the build is fast', () => {
    _resetLocaleJobsSplitSignalForTests();
    expect(shouldAwaitLocaleJobsSplitFlushed(false)).toBe(false);

    const plugin = localeJobsSplitPlugin(makeRoot());
    expect(shouldAwaitLocaleJobsSplitFlushed(false)).toBe(false);
    (plugin.buildStart as () => void)();
    expect(shouldAwaitLocaleJobsSplitFlushed(false)).toBe(true);
    expect(shouldAwaitLocaleJobsSplitFlushed(true)).toBe(false);
    expect(plugin.name).toBe('locale-jobs-split');
  });

  it('resolves the SSG config without registering an omitted locale-split producer', async () => {
    const envNames = ['BUILD_STAGE', 'FAST_BUILD'] as const;
    const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    _resetLocaleJobsSplitSignalForTests();
    process.env.BUILD_STAGE = 'ssg';
    delete process.env.FAST_BUILD;

    try {
      const resolved = await resolveConfig(
        { configFile: path.resolve(process.cwd(), 'vite.config.ts'), mode: 'production' },
        'build',
        'production',
      );
      const pluginNames = resolved.plugins.map((plugin) => plugin.name);

      expect(pluginNames).toContain('jobs-seo-pages');
      expect(pluginNames).not.toContain('locale-jobs-split');
      expect(shouldAwaitLocaleJobsSplitFlushed(false)).toBe(false);
    } finally {
      _resetLocaleJobsSplitSignalForTests();
      for (const name of envNames) {
        const value = previousEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('prevents a consumer-first parallel closeBundle from reading the stale Worker map', async () => {
    const root = makeRoot();
    const mapPath = path.join(root, 'dist', 'data', 'jobs-slug-map.json');
    fs.writeFileSync(mapPath, '[{"slug":"stale"}]');
    const plugin = localeJobsSplitPlugin(root);
    (plugin.buildStart as () => void)();
    const completion = localeJobsSplitFlushed;
    const staleReadWithoutBarrier = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    expect(staleReadWithoutBarrier).toEqual([{ slug: 'stale' }]);

    // Rollup invokes parallel hooks independently. Start the consumer hook
    // first, then let the synchronous producer hook write its map.
    const consumer = (async () => {
      if (shouldAwaitLocaleJobsSplitFlushed(false)) {
        const outcome = await completion;
        if (outcome.ok === false) throw outcome.error;
      }
      return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    })();
    closeSplit(plugin);

    await expect(completion).resolves.toEqual({ ok: true });
    await expect(consumer).resolves.toEqual([]);
  });

  it('settles with the original error and never releases consumers to read a stale map', async () => {
    const root = makeRoot();
    const staleMapPath = path.join(root, 'dist', 'data', 'jobs-slug-map.json');
    fs.writeFileSync(staleMapPath, '[{"slug":"stale"}]');
    fs.writeFileSync(path.join(root, 'data', 'ats-application-forms.json'), '{invalid');
    const plugin = localeJobsSplitPlugin(root);
    (plugin.buildStart as () => void)();
    const completion = localeJobsSplitFlushed;
    const consumer = (async () => {
      const outcome = await completion;
      if (outcome.ok === false) throw outcome.error;
      return fs.readFileSync(staleMapPath, 'utf8');
    })();
    let producerError: unknown;

    try {
      closeSplit(plugin);
    } catch (error) {
      producerError = error;
    }

    expect(producerError).toBeInstanceOf(Error);
    await expect(completion).resolves.toEqual({ ok: false, error: producerError });
    await expect(consumer).rejects.toBe(producerError);
    expect(fs.readFileSync(staleMapPath, 'utf8')).toBe('[{"slug":"stale"}]');
  });

  it('makes jobs SEO await the registered producer immediately before reading its map', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    const awaitIndex = source.indexOf('await localeJobsSplitFlushed;');
    const mapReadIndex = source.indexOf('const serializedWorkerJobs = readFinalWorkerSlugMap(distDir);');

    expect(source).toContain('if (shouldAwaitLocaleJobsSplitFlushed()) {');
    expect(source).toContain('if (localeJobsSplitOutcome.ok === false) throw localeJobsSplitOutcome.error;');
    expect(awaitIndex).toBeGreaterThanOrEqual(0);
    expect(mapReadIndex).toBeGreaterThan(awaitIndex);
  });
});
