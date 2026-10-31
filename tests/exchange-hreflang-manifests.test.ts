import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { serializeHreflangManifest } from '../scripts/lib/hreflang-index-manifest.mjs';
import {
  BARRIER_JOB_ELAPSED_MS,
  DEFAULT_DOWNLOAD_BUDGET_MS,
  ManifestExchangeError,
  exchangeHreflangManifests,
  manifestArtifactName,
} from '../scripts/ci/exchange-hreflang-manifests.mjs';

/**
 * Run 41088323300 lost three legs after two hours of build: the cache lookup
 * reported a hit, the transfer answered `Egress is over the account limit`, and
 * actions/cache/restore degraded it to a warning plus a miss. These tests pin
 * the replacement: transient errors are retried, the outcome stays fail-closed.
 */

const REPO = 'owner/repo';
const RUN_ID = '41088323300';
const RUN_ATTEMPT = '1';
const JOB_START_MS = 1_000_000;
const MINUTE = 60_000;
const EGRESS = Object.assign(new Error('Command failed'), { stderr: 'Egress is over the account limit.\n' });

function manifestText(locale: string, runId = RUN_ID) {
  return serializeHreflangManifest({ locale, entries: new Map([[`/${locale}/a/`, 'cluster-a']]), runId });
}

/** Fake `gh`: answers the two list endpoints and writes the artifact file. */
function fakeGh({
  published = ['it', 'en', 'de', 'fr'],
  jobs = [] as Array<{ name: string; conclusion: string | null; run_attempt?: number }>,
  download = {} as Record<string, Array<Error | string>>,
  list = undefined as undefined | ((url: string) => unknown),
} = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[], timeoutMs: number) => {
    calls.push(args);
    expect(timeoutMs).toBeGreaterThan(0);
    if (args[0] === 'api') {
      const url = args.at(-1) as string;
      const override = list?.(url);
      if (override !== undefined) return JSON.stringify(override);
      if (url.includes('/jobs?')) return JSON.stringify({ jobs });
      const name = decodeURIComponent(url.split('name=')[1]);
      const locale = name.split('-')[3];
      return JSON.stringify({
        artifacts: published.includes(locale) ? [{ name, expired: false }] : [],
      });
    }
    const name = args[args.indexOf('--name') + 1];
    const dir = args[args.indexOf('--dir') + 1];
    const locale = name.split('-')[3];
    const next = download[locale]?.shift();
    if (next instanceof Error) throw next;
    fs.writeFileSync(path.join(dir, `${locale}.json`), next ?? manifestText(locale));
    return '';
  };
  return { gh, calls };
}

describe('exchangeHreflangManifests', () => {
  let manifestDir: string;
  let clock: number;
  const logs: string[] = [];
  const base = () => ({
    repo: REPO,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    buildLocale: 'fr',
    manifestDir,
    jobStartEpoch: String(JOB_START_MS / 1000),
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    log: (line: string) => { logs.push(line); },
  });

  beforeEach(() => {
    manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-exchange-'));
    clock = JOB_START_MS;
    logs.length = 0;
  });
  afterEach(() => {
    fs.rmSync(manifestDir, { recursive: true, force: true });
  });

  const written = () => fs.readdirSync(manifestDir).sort();

  it('downloads exactly the three foreign manifests of this run attempt', async () => {
    const { gh, calls } = fakeGh();
    await exchangeHreflangManifests({ ...base(), gh });
    expect(written()).toEqual(['de.json', 'en.json', 'it.json']);
    const names = calls.filter((args) => args[0] === 'run').map((args) => args[args.indexOf('--name') + 1]);
    expect(names).toEqual(['it', 'en', 'de'].map((l) => manifestArtifactName(l, RUN_ID, RUN_ATTEMPT)));
  });

  it('survives the egress failure that killed run 41088323300', async () => {
    const { gh } = fakeGh({ download: { it: [EGRESS, EGRESS] } });
    await exchangeHreflangManifests({ ...base(), gh });
    expect(written()).toEqual(['de.json', 'en.json', 'it.json']);
    expect(logs.filter((l) => l.startsWith('::warning::') && l.includes('Egress is over the account limit'))).toHaveLength(2);
  });

  it('retries with backoff instead of hammering the throttled store', async () => {
    const delays: number[] = [];
    const { gh } = fakeGh({ download: { it: [EGRESS, EGRESS, EGRESS] } });
    await exchangeHreflangManifests({
      ...base(),
      gh,
      sleep: async (ms: number) => { delays.push(ms); clock += ms; },
    });
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  it('fails closed when the download budget runs out, leaving no partial file', async () => {
    const { gh } = fakeGh({ download: { it: Array(100).fill(EGRESS) } });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(
      /same-run hreflang manifest unavailable after \d+ tries: it \(Egress is over the account limit\.\)/,
    );
    expect(written()).toEqual([]);
  });

  it('shares one download budget across the sibling manifests', async () => {
    const start = clock;
    const { gh } = fakeGh({
      download: { it: Array(100).fill(EGRESS), en: Array(100).fill(EGRESS), de: Array(100).fill(EGRESS) },
    });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toBeInstanceOf(ManifestExchangeError);
    expect(clock - start).toBeLessThanOrEqual(DEFAULT_DOWNLOAD_BUDGET_MS);
  });

  it('shared download budget stops after deadline', async () => {
    const { gh: fake, calls } = fakeGh();
    const slowGh = async (args: string[], timeoutMs: number) => {
      const out = await fake(args, timeoutMs);
      if (args[0] === 'run') clock += DEFAULT_DOWNLOAD_BUDGET_MS + 1;
      return out;
    };
    await expect(exchangeHreflangManifests({ ...base(), gh: slowGh })).rejects.toThrow(
      'same-run hreflang manifest unavailable after 1 tries: it (download budget exhausted)',
    );
    expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
    expect(written()).toEqual([]);
  });

  it('stops before the next locale when the budget ran out between downloads', async () => {
    const { gh: fake, calls } = fakeGh();
    let downloads = 0;
    const slowGh = async (args: string[], timeoutMs: number) => {
      const out = await fake(args, timeoutMs);
      if (args[0] === 'run') {
        downloads += 1;
        // Still inside the budget when it returns; the last ms goes between locales.
        clock += DEFAULT_DOWNLOAD_BUDGET_MS - 1;
      }
      return out;
    };
    await expect(exchangeHreflangManifests({
      ...base(),
      gh: slowGh,
      log: (line: string) => { if (line.includes('downloaded')) clock += 1; },
    })).rejects.toThrow('same-run hreflang manifest unavailable after 0 tries: en (download budget exhausted)');
    expect(downloads).toBe(1);
    expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
    expect(written()).toEqual(['it.json']);
  });

  it('never gives one try more time than the budget has left', async () => {
    const timeouts: number[] = [];
    const { gh: fake } = fakeGh({ download: { it: [EGRESS] } });
    const recordingGh = async (args: string[], timeoutMs: number) => {
      if (args[0] === 'run') {
        timeouts.push(timeoutMs);
        clock += DEFAULT_DOWNLOAD_BUDGET_MS - 60_000;
      }
      return fake(args, timeoutMs);
    };
    await expect(exchangeHreflangManifests({
      ...base(),
      gh: recordingGh,
    })).rejects.toBeInstanceOf(ManifestExchangeError);
    expect(timeouts[0]).toBe(180_000);
    expect(timeouts[1]).toBeLessThanOrEqual(55_000);
  });

  it('does not retry a corrupt manifest: the artifact is immutable', async () => {
    const { gh, calls } = fakeGh({ download: { it: ['{"version":1'] } });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/invalid same-run hreflang manifest it: unparsable/);
    expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
    expect(written()).toEqual([]);
  });

  it('rejects a manifest of another run', async () => {
    const { gh } = fakeGh({ download: { it: [manifestText('it', '999')] } });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(
      `foreign same-run hreflang manifest it: runId=999, expected=${RUN_ID}`,
    );
    expect(written()).toEqual([]);
  });

  it('rejects an artifact that does not contain the expected file', async () => {
    const gh = async (args: string[]) => (args[0] === 'api'
      ? JSON.stringify({ jobs: [], artifacts: [{ name: args.at(-1)?.split('name=')[1], expired: false }] })
      : '');
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/invalid same-run hreflang manifest it/);
  });

  describe('on a rerun', () => {
    const rerun = { runAttempt: '2' };
    // Artifact names carry the attempt; the fake answers per exact name.
    const artifactsFor = (names: string[]) => (url: string) => {
      if (url.includes('/jobs?')) return undefined;
      const name = decodeURIComponent(url.split('name=')[1]);
      return { artifacts: names.includes(name) ? [{ name, expired: false }] : [] };
    };
    const names = (attempts: Record<string, number>) => Object.entries(attempts)
      .map(([locale, attempt]) => manifestArtifactName(locale, RUN_ID, attempt));

    it('reads a sibling that already shipped from the attempt in which it succeeded', async () => {
      // Run 41088323300: it stayed green, en/de/fr are the legs being rerun.
      const { gh, calls } = fakeGh({
        jobs: [
          { name: 'build-locale (it)', conclusion: 'success', run_attempt: 1 },
          { name: 'build-locale (en)', conclusion: null, run_attempt: 2 },
          { name: 'build-locale (de)', conclusion: null, run_attempt: 2 },
          { name: 'build-locale (fr)', conclusion: null, run_attempt: 2 },
        ],
        list: artifactsFor(names({ it: 1, en: 2, de: 2, fr: 2 })),
      });
      await exchangeHreflangManifests({ ...base(), ...rerun, gh });
      expect(written()).toEqual(['de.json', 'en.json', 'it.json']);
      const downloaded = calls.filter((args) => args[0] === 'run').map((args) => args[args.indexOf('--name') + 1]);
      expect(downloaded).toEqual(names({ it: 1, en: 2, de: 2 }));
    });

    it('drops a manifest seen earlier when the job list then shows that leg running again', async () => {
      const jobs: Array<{ name: string; conclusion: string | null; run_attempt?: number }> = [
        { name: 'build-locale (it)', conclusion: 'success', run_attempt: 1 },
      ];
      const available = names({ it: 1, en: 2, de: 2 });
      const { gh, calls } = fakeGh({ jobs, list: artifactsFor(available) });
      let polls = 0;
      await exchangeHreflangManifests({
        ...base(),
        ...rerun,
        gh,
        sleep: async (ms: number) => {
          clock += ms;
          polls += 1;
          if (polls === 1) jobs[0] = { name: 'build-locale (it)', conclusion: null, run_attempt: 2 };
          if (polls === 2) available.push(...names({ it: 2, fr: 2 }));
        },
      });
      expect(polls).toBe(2);
      const downloaded = calls.filter((args) => args[0] === 'run').map((args) => args[args.indexOf('--name') + 1]);
      expect(downloaded).toContain(manifestArtifactName('it', RUN_ID, 2));
      expect(downloaded).not.toContain(manifestArtifactName('it', RUN_ID, 1));
    });

    it('lets the newest attempt decide, whatever order the jobs are listed in', async () => {
      const older = { name: 'build-locale (it)', conclusion: 'success', run_attempt: 1 };
      const newer = { name: 'build-locale (it)', conclusion: null, run_attempt: 2 };
      for (const jobs of [[older, newer], [newer, older]]) {
        const { gh } = fakeGh({ jobs, list: artifactsFor(names({ it: 1, en: 2, de: 2, fr: 2 })) });
        await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(/barrier timed out waiting for it/);
        clock = JOB_START_MS;
      }
    });

    it('does not abort on a failed entry of a leg that is running again', async () => {
      const { gh } = fakeGh({
        jobs: [
          { name: 'build-locale (de)', conclusion: 'failure', run_attempt: 1 },
          { name: 'build-locale (de)', conclusion: null, run_attempt: 2 },
        ],
        list: artifactsFor(names({ it: 2, en: 2, fr: 2 })),
      });
      await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(/barrier timed out waiting for de/);
    });

    it('does not read an earlier attempt of a leg that is running again', async () => {
      const { gh } = fakeGh({
        jobs: [
          { name: 'build-locale (it)', conclusion: 'success', run_attempt: 2 },
          { name: 'build-locale (en)', conclusion: null, run_attempt: 2 },
          { name: 'build-locale (de)', conclusion: 'success', run_attempt: 2 },
          { name: 'build-locale (fr)', conclusion: null, run_attempt: 2 },
        ],
        // en published only under attempt 1: that file belongs to the failed try.
        list: artifactsFor(names({ it: 2, en: 1, de: 2, fr: 2 })),
      });
      await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(/barrier timed out waiting for en/);
    });

    it('never reads ahead of the current attempt', async () => {
      const { gh } = fakeGh({
        jobs: [{ name: 'build-locale (it)', conclusion: 'success', run_attempt: 3 }],
        list: artifactsFor(names({ it: 3, en: 2, de: 2, fr: 2 })),
      });
      await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(/barrier timed out waiting for it/);
    });

    it('waits for a sibling whose only failure belongs to an earlier attempt', async () => {
      const { gh } = fakeGh({
        published: [],
        jobs: [{ name: 'build-locale (de)', conclusion: 'failure', run_attempt: 1 }],
      });
      await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(/barrier timed out/);
      expect(clock - JOB_START_MS).toBeGreaterThanOrEqual(BARRIER_JOB_ELAPSED_MS);
    });

    it('aborts on a sibling that failed in this attempt', async () => {
      const { gh } = fakeGh({
        published: [],
        jobs: [{ name: 'build-locale (de)', conclusion: 'failure', run_attempt: 2 }],
      });
      await expect(exchangeHreflangManifests({ ...base(), ...rerun, gh })).rejects.toThrow(
        'same-run hreflang manifest barrier aborted: build-locale (de)',
      );
    });
  });

  it('holds the barrier until the slowest sibling publishes', async () => {
    const published = ['it', 'en', 'fr'];
    const { gh, calls } = fakeGh({ published });
    let polls = 0;
    await exchangeHreflangManifests({
      ...base(),
      gh,
      sleep: async (ms: number) => {
        clock += ms;
        polls += 1;
        if (polls === 3) published.push('de');
      },
    });
    expect(polls).toBe(3);
    expect(calls.findIndex((args) => args[0] === 'run'))
      .toBeGreaterThan(calls.findLastIndex((args) => args[0] === 'api'));
  });

  it('keeps waiting through a failed API poll', async () => {
    let failures = 2;
    const { gh } = fakeGh({
      list: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('HTTP 502: Server Error');
        }
        return undefined;
      },
    });
    await exchangeHreflangManifests({ ...base(), gh });
    expect(logs.filter((l) => l.includes('barrier poll failed: HTTP 502'))).toHaveLength(2);
    expect(written()).toHaveLength(3);
  });

  it('waits for the healthy locale skew observed in run 41119148516', async () => {
    const start = clock;
    // The first and last manifests were published 62m04s apart. All producer
    // jobs were still healthy when the old one-hour readiness budget expired.
    const slowestManifestLagMs = (62 * 60 + 4) * 1_000;
    const published = ['en', 'de', 'fr'];
    const { gh, calls } = fakeGh({ published });
    await exchangeHreflangManifests({
      ...base(),
      gh,
      pollMs: 60_000,
      sleep: async (ms: number) => {
        clock += ms;
        if (clock - start >= slowestManifestLagMs) published.push('it');
      },
    });
    expect(clock - start).toBeGreaterThan(60 * 60_000);
    expect(clock - start).toBeLessThan(BARRIER_JOB_ELAPSED_MS);
    expect(written()).toEqual(['de.json', 'en.json', 'it.json']);
    expect(calls.findIndex((args) => args[0] === 'run'))
      .toBeGreaterThan(calls.findLastIndex((args) => args[0] === 'api'));
  });

  it('ignores an expired artifact', async () => {
    const { gh } = fakeGh({
      list: (url) => (url.includes('-de-') ? { artifacts: [{ name: url.split('name=')[1], expired: true }] } : undefined),
    });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/barrier timed out waiting for de/);
  });

  it('aborts the barrier as soon as a sibling leg has terminated', async () => {
    const { gh } = fakeGh({
      published: ['fr'],
      jobs: [
        { name: 'prep', conclusion: 'failure', run_attempt: 1 },
        { name: 'build-locale (fr)', conclusion: null, run_attempt: 1 },
        { name: 'build-locale (de)', conclusion: 'failure', run_attempt: 1 },
      ],
    });
    const start = clock;
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(
      'same-run hreflang manifest barrier aborted: build-locale (de) terminated before publishing its manifest',
    );
    expect(clock).toBe(start);
  });

  it('times out naming the missing locale, at the job deadline', async () => {
    const { gh } = fakeGh({ published: ['it', 'fr'] });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/barrier timed out waiting for en/);
    expect(clock - JOB_START_MS).toBeGreaterThanOrEqual(BARRIER_JOB_ELAPSED_MS);
    expect(clock - JOB_START_MS).toBeLessThan(BARRIER_JOB_ELAPSED_MS + MINUTE);
  });

  it('survives the 62-minute gap between legs that killed run 41119148516', async () => {
    // en reached the barrier 72 minutes in, it published 134 minutes in.
    clock = JOB_START_MS + 72 * MINUTE;
    const published = ['en', 'fr', 'de'];
    const { gh } = fakeGh({ published });
    await exchangeHreflangManifests({
      ...base(),
      gh,
      buildLocale: 'en',
      sleep: async (ms: number) => {
        clock += ms;
        if (clock >= JOB_START_MS + 134 * MINUTE && !published.includes('it')) published.push('it');
      },
    });
    expect(written()).toEqual(['de.json', 'fr.json', 'it.json']);
  });

  it('anchors the wait to the job start, not to when the leg arrived', async () => {
    clock = JOB_START_MS + BARRIER_JOB_ELAPSED_MS - 5 * MINUTE;
    const arrived = clock;
    const { gh } = fakeGh({ published: ['fr'] });
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/barrier timed out/);
    expect(clock - arrived).toBeLessThan(6 * MINUTE);
  });

  it('does not list again a manifest it has already seen', async () => {
    const published = ['it', 'en', 'fr'];
    const { gh, calls } = fakeGh({ published });
    let polls = 0;
    await exchangeHreflangManifests({
      ...base(),
      gh,
      sleep: async (ms: number) => {
        clock += ms;
        polls += 1;
        if (polls === 5) published.push('de');
      },
    });
    const listed = (locale: string) => calls.filter((args) => args[0] === 'api' && args.at(-1)?.includes(`-${locale}-`)).length;
    expect(listed('it')).toBe(1);
    expect(listed('en')).toBe(1);
    expect(listed('de')).toBe(6);
  });

  it('refuses an unknown leg or a missing input before touching the network', async () => {
    const { gh, calls } = fakeGh();
    await expect(exchangeHreflangManifests({ ...base(), gh, buildLocale: 'es' })).rejects.toThrow(/unknown hreflang build locale: es/);
    await expect(exchangeHreflangManifests({ ...base(), gh, runId: '' })).rejects.toThrow(/missing hreflang manifest exchange input: runId/);
    await expect(exchangeHreflangManifests({ ...base(), gh, jobStartEpoch: '' })).rejects.toThrow(/missing hreflang manifest exchange input: jobStartEpoch/);
    await expect(exchangeHreflangManifests({ ...base(), gh, jobStartEpoch: 'soon' })).rejects.toThrow(/invalid hreflang job start epoch: soon/);
    expect(calls).toHaveLength(0);
  });
});

describe('deploy.yml hreflang manifest exchange', () => {
  type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; 'timeout-minutes'?: number; 'continue-on-error'?: boolean };
  const raw = fs.readFileSync(path.resolve(import.meta.dirname, '../.github/workflows/deploy.yml'), 'utf-8');
  const steps: Step[] = YAML.parse(raw).jobs['build-locale'].steps;
  const index = (name: string) => steps.findIndex((step) => step.name === name);
  const byName = (name: string) => steps[index(name)];
  const PUBLISH = 'Publish hreflang index manifest (${{ matrix.locale }})';
  const RETRY = 'Retry hreflang index manifest publish (${{ matrix.locale }})';
  const EXCHANGE = 'Exchange same-run hreflang manifests';
  const REWRITE = 'Hreflang index manifest (keep only reciprocal indexable clusters)';

  it('never moves the mandatory manifest through actions/cache', () => {
    const offenders = steps.filter((step) => step.uses?.startsWith('actions/cache')
      && `${step.with?.path} ${step.with?.key}`.includes('hreflang-index-manifest'));
    expect(offenders.map((step) => step.name)).toEqual([]);
  });

  it('publishes, retries, exchanges and only then rewrites', () => {
    const order = ['Hreflang index manifest (pre-barrier, no rewrite)', PUBLISH, RETRY, EXCHANGE, REWRITE].map(index);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(byName(REWRITE).run).toContain('--require-foreign-manifests');
  });

  it('keys the artifact by locale, run and attempt, as the script expects', () => {
    const template = '${{ matrix.locale }}-${{ github.run_id }}-${{ github.run_attempt }}';
    expect(manifestArtifactName('${{ matrix.locale }}', '${{ github.run_id }}', '${{ github.run_attempt }}'))
      .toBe(`hreflang-index-manifest-${template}`);
    for (const name of [PUBLISH, RETRY]) {
      expect(byName(name).with).toMatchObject({
        name: `hreflang-index-manifest-${template}`,
        path: '.cache/hreflang-index-manifest/${{ matrix.locale }}.json',
        'if-no-files-found': 'error',
        // The path is under a dot directory, which upload-artifact can skip.
        'include-hidden-files': true,
      });
    }
  });

  it('retries the upload only after a real failure of the first one', () => {
    expect(byName(PUBLISH)['continue-on-error']).toBe(true);
    expect(byName(RETRY).if).toBe("steps.publish-hreflang-index-manifest.outcome == 'failure'");
    expect(byName(RETRY).with?.overwrite).toBe(true);
    expect(byName(RETRY)['continue-on-error']).toBeUndefined();
  });

  it('anchors the barrier to the first step of the leg', () => {
    expect(byName(EXCHANGE).env?.HREFlANG_JOB_START_EPOCH).toBe('${{ env.CDN_JOB_START_EPOCH }}');
    const start = steps.findIndex((step) => step.run?.includes('CDN_JOB_START_EPOCH=$(date +%s)'));
    expect(start).toBe(0);
    expect(steps[start].if).toBeUndefined();
  });

  it('keeps enough of the job after the barrier for the slowest leg', () => {
    const jobMs = YAML.parse(raw).jobs['build-locale']['timeout-minutes'] * MINUTE;
    const postBarrierOfItMs = 76 * MINUTE;
    expect(BARRIER_JOB_ELAPSED_MS + DEFAULT_DOWNLOAD_BUDGET_MS + postBarrierOfItMs).toBeLessThan(jobMs);
  });

  it('gives the exchange the inputs it reads and a bound above its own budgets', () => {
    const exchange = byName(EXCHANGE);
    expect(exchange.run).toContain('node scripts/ci/exchange-hreflang-manifests.mjs');
    expect(Object.keys(exchange.env ?? {})).toEqual(expect.arrayContaining([
      'GH_TOKEN', 'GH_REPO', 'HREFlANG_BUILD_LOCALE', 'HREFlANG_JOB_START_EPOCH', 'HREFlANG_RUN_ID', 'HREFlANG_RUN_ATTEMPT',
    ]));
    expect(exchange['continue-on-error']).toBeUndefined();
    expect((exchange['timeout-minutes'] ?? 0) * MINUTE).toBeGreaterThan(BARRIER_JOB_ELAPSED_MS + DEFAULT_DOWNLOAD_BUDGET_MS);
    expect(exchange['timeout-minutes']).toBeLessThan(YAML.parse(raw).jobs['build-locale']['timeout-minutes']);
  });

  it('lets the leg read artifacts with the job token', () => {
    expect(YAML.parse(raw).jobs['build-locale'].permissions.actions).toBe('read');
  });
});
