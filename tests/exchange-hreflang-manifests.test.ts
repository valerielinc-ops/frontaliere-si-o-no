import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { serializeHreflangManifest } from '../scripts/lib/hreflang-index-manifest.mjs';
import {
  DEFAULT_BARRIER_MS,
  DEFAULT_POLL_MS,
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
const EGRESS = Object.assign(new Error('Command failed'), { stderr: 'Egress is over the account limit.\n' });

function manifestText(locale: string, runId = RUN_ID) {
  return serializeHreflangManifest({ locale, entries: new Map([[`/${locale}/a/`, 'cluster-a']]), runId });
}

/** Fake `gh`: answers the two list endpoints and writes the artifact file. */
function fakeGh({
  published = ['it', 'en', 'de', 'fr'],
  jobs = [] as Array<{ name: string; conclusion: string | null }>,
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
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    log: (line: string) => { logs.push(line); },
  });

  beforeEach(() => {
    manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-exchange-'));
    clock = 1_000_000;
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
    expect(clock - start).toBeLessThan(DEFAULT_BARRIER_MS);
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
        { name: 'prep', conclusion: 'failure' },
        { name: 'build-locale (fr)', conclusion: null },
        { name: 'build-locale (de)', conclusion: 'failure' },
      ],
    });
    const start = clock;
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(
      'same-run hreflang manifest barrier aborted: build-locale (de) terminated before publishing its manifest',
    );
    expect(clock).toBe(start);
  });

  it('times out naming the missing locale', async () => {
    const { gh } = fakeGh({ published: ['it', 'fr'] });
    const start = clock;
    await expect(exchangeHreflangManifests({ ...base(), gh })).rejects.toThrow(/barrier timed out waiting for en/);
    expect(clock - start).toBeGreaterThanOrEqual(DEFAULT_BARRIER_MS);
    expect(clock - start).toBeLessThanOrEqual(DEFAULT_BARRIER_MS + DEFAULT_POLL_MS);
  });

  it('refuses an unknown leg or a missing input before touching the network', async () => {
    const { gh, calls } = fakeGh();
    await expect(exchangeHreflangManifests({ ...base(), gh, buildLocale: 'es' })).rejects.toThrow(/unknown hreflang build locale: es/);
    await expect(exchangeHreflangManifests({ ...base(), gh, runId: '' })).rejects.toThrow(/missing hreflang manifest exchange input: runId/);
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

  it('gives the exchange the inputs it reads and a bound above its own budgets', () => {
    const exchange = byName(EXCHANGE);
    expect(exchange.run).toContain('node scripts/ci/exchange-hreflang-manifests.mjs');
    expect(Object.keys(exchange.env ?? {})).toEqual(expect.arrayContaining([
      'GH_TOKEN', 'GH_REPO', 'HREFlANG_BUILD_LOCALE', 'HREFlANG_RUN_ID', 'HREFlANG_RUN_ATTEMPT',
    ]));
    expect(exchange['continue-on-error']).toBeUndefined();
    expect((exchange['timeout-minutes'] ?? 0) * 60_000).toBeGreaterThan(DEFAULT_BARRIER_MS + DEFAULT_DOWNLOAD_BUDGET_MS);
    expect(exchange['timeout-minutes']).toBeLessThan(YAML.parse(raw).jobs['build-locale']['timeout-minutes']);
  });

  it('lets the leg read artifacts with the job token', () => {
    expect(YAML.parse(raw).jobs['build-locale'].permissions.actions).toBe('read');
  });
});
