import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: vi.fn().mockRejectedValue(new Error('browser unavailable in test')),
}));

import {
  createWorkdayRequestContext,
  resetWorkdayImplicitRateLimitStateForTests,
  WorkdayRateLimitCooldownError,
  WorkdayRateLimitError,
} from '../scripts/lib/ats-clients/workday-client.mjs';
import {
  WORKDAY_COOLDOWN_CAP_MS,
  hydrateWorkdayCooldown,
  resetWorkdayCooldownRegistryForTests,
  workdayCooldownDelayMs,
  workdayCooldownSummaryField,
} from '../scripts/lib/workday-rate-limit-cooldown.mjs';
import {
  buildAggregateIssue,
  nextCrawlerState,
} from '../scripts/check-crawler-health.mjs';
import {
  buildCrawlerAggregateFailureGateShellBody,
  buildCrawlerAggregateShellBody,
} from '../scripts/generate-crawler-group-workflows.mjs';

const HOUR = 60 * 60 * 1000;
const API_BASE = 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon';
const TENANT = API_BASE;
const T0 = Date.parse('2026-11-28T00:00:00.000Z');

type Record = ReturnType<typeof workdayCooldownSummaryField>;

/** One crawler process: hydrate the previous summary field, make one request. */
async function runOnce(previous: Record, nowMs: number, fetchImpl: () => Promise<Response>) {
  resetWorkdayCooldownRegistryForTests();
  resetWorkdayImplicitRateLimitStateForTests();
  hydrateWorkdayCooldown(previous);
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchMock);
  const relayFallback = vi.fn().mockResolvedValue({ status: 429, text: '', upstream: true });
  const context = createWorkdayRequestContext(API_BASE, {
    relayFallback,
    browserFallback: null,
    fallbackCooldownMs: 0,
    egressStateDir: null,
    relayBackoffMs: 0,
    relaySleep: async () => {},
    cooldownNow: () => nowMs,
  } as never);
  let error: unknown = null;
  let data: unknown = null;
  try {
    data = await context.request(`${API_BASE}/jobs`, { method: 'POST', body: '{}', retries: 0, retryBaseMs: 0 });
  } catch (err) {
    error = err;
  } finally {
    await context.close();
  }
  return {
    error,
    data,
    requests: fetchMock.mock.calls.length + relayFallback.mock.calls.length,
    field: workdayCooldownSummaryField(nowMs),
  };
}

const tooMany = async () => new Response('', { status: 429 });
const ok = async () => new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });

beforeEach(() => {
  vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
  vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
});

afterEach(() => {
  resetWorkdayCooldownRegistryForTests();
  resetWorkdayImplicitRateLimitStateForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Workday cross-run cooldown (#20279)', () => {
  it('backs off 6 h, 12 h, 24 h, caps at 24 h and honours a longer Retry-After up to the cap', () => {
    expect([1, 2, 3, 4, 9].map((n) => workdayCooldownDelayMs(n) / HOUR)).toEqual([6, 12, 24, 24, 24]);
    expect(workdayCooldownDelayMs(1, 10 * HOUR) / HOUR).toBe(10);
    expect(workdayCooldownDelayMs(1, 2 * 60 * 1000) / HOUR).toBe(6);
    expect(workdayCooldownDelayMs(1, 90 * HOUR)).toBe(WORKDAY_COOLDOWN_CAP_MS);
  });

  it('a tenant answering 429 on the first request enters a 6 h cooldown', async () => {
    const run = await runOnce(null, T0, tooMany);

    expect(run.error).toBeInstanceOf(WorkdayRateLimitError);
    expect(run.error).not.toBeInstanceOf(WorkdayRateLimitCooldownError);
    expect(run.field).toMatchObject({
      tenant: TENANT,
      firstRateLimitedAt: new Date(T0).toISOString(),
      lastRateLimitedAt: new Date(T0).toISOString(),
      consecutiveRuns: 1,
      nextAttemptAfter: new Date(T0 + 6 * HOUR).toISOString(),
      outcome: 'rate-limited',
    });
  });

  it('the next run before expiry sends no request at all and reports rate-limited-cooldown', async () => {
    const first = await runOnce(null, T0, tooMany);
    const second = await runOnce(first.field, T0 + 3 * HOUR, tooMany);

    expect(second.requests).toBe(0);
    expect(second.error).toBeInstanceOf(WorkdayRateLimitCooldownError);
    // Same typed family: every crawler boundary already soft-exits on it with
    // the previous slice live (exhausted_retry / retryable-http-response).
    expect(second.error).toBeInstanceOf(WorkdayRateLimitError);
    expect((second.error as WorkdayRateLimitError).retryExhausted).toBe(true);
    expect(second.field).toMatchObject({
      outcome: 'rate-limited-cooldown',
      consecutiveRuns: 1,
      nextAttemptAfter: first.field!.nextAttemptAfter,
    });
  });

  it('retries after expiry and grows 12 h then 24 h, never past the cap', async () => {
    let record: Record = null;
    let now = T0;
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await runOnce(record, now, tooMany);
      expect(run.requests).toBeGreaterThan(0);
      record = run.field;
      delays.push((Date.parse(record!.nextAttemptAfter) - now) / HOUR);
      now = Date.parse(record!.nextAttemptAfter) + 1000;
    }
    expect(delays).toEqual([6, 12, 24, 24]);
    expect(record!.consecutiveRuns).toBe(4);
    expect(record!.firstRateLimitedAt).toBe(new Date(T0).toISOString());
  });

  it('honours Retry-After when it is longer than the step', async () => {
    const run = await runOnce(null, T0, async () => new Response('', { status: 429, headers: { 'Retry-After': String(10 * 3600) } }));
    expect((Date.parse(run.field!.nextAttemptAfter) - T0) / HOUR).toBe(10);
  });

  it('a success clears the cooldown', async () => {
    const first = await runOnce(null, T0, tooMany);
    const later = Date.parse(first.field!.nextAttemptAfter) + 1000;
    const recovered = await runOnce(first.field, later, ok);

    expect(recovered.error).toBeNull();
    expect(recovered.field).toBeNull();
  });

  it('never blocks longer than the cap after the last contact, even with a corrupt record', async () => {
    const corrupt = {
      tenant: TENANT,
      firstRateLimitedAt: new Date(T0).toISOString(),
      lastRateLimitedAt: new Date(T0).toISOString(),
      consecutiveRuns: 3,
      nextAttemptAfter: new Date(T0 + 400 * HOUR).toISOString(),
      outcome: 'rate-limited',
    } as Record;
    const run = await runOnce(corrupt, T0 + 25 * HOUR, ok);
    expect(run.error).toBeNull();
    expect(run.requests).toBe(1);
  });

  it('ignores an unreadable record (fail-open) and another tenant\'s record', async () => {
    const run = await runOnce({ tenant: 42 } as never, T0, ok);
    expect(run.error).toBeNull();
    const other = await runOnce({
      tenant: 'https://other.wd3.myworkdayjobs.com/wday/cxs/other/x',
      firstRateLimitedAt: new Date(T0).toISOString(),
      lastRateLimitedAt: new Date(T0).toISOString(),
      consecutiveRuns: 1,
      nextAttemptAfter: new Date(T0 + 6 * HOUR).toISOString(),
      outcome: 'rate-limited',
    } as Record, T0 + HOUR, ok);
    expect(other.error).toBeNull();
  });
});

describe('crawler group gate with a member in cooldown (#20279)', () => {
  function runGroup(statuses: Record<string, number>) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-gate-'));
    try {
      const stateDir = path.join(temp, 'crawler-generation', 'group-22');
      fs.mkdirSync(stateDir, { recursive: true });
      for (const [slug, status] of Object.entries(statuses)) {
        fs.writeFileSync(path.join(stateDir, `${slug}.status`), `${status}\n`);
      }
      const output = path.join(temp, 'output.txt');
      const env = {
        ...process.env,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
      };
      const members = Object.keys(statuses).map((slug) => ({ slug }));
      execFileSync('bash', ['-e', '-c', buildCrawlerAggregateShellBody(members as never, 22)], { env, encoding: 'utf8' });
      const counts = Object.fromEntries(
        fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')),
      );
      const gate = spawnSync('bash', ['-e', '-c', buildCrawlerAggregateFailureGateShellBody()], {
        env: {
          ...process.env,
          CRAWLER_AGGREGATE_OUTCOME: 'success',
          CRAWLER_AGGREGATE_SUCCESS: counts.success_count,
          CRAWLER_AGGREGATE_FAILURES: counts.failure_count,
          CRAWLER_AGGREGATE_MISSING: counts.missing_count,
          CRAWLER_AGGREGATE_SYSTEMIC: counts.systemic_count,
        },
        encoding: 'utf8',
      });
      return gate.status;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  it('a member that soft-exits in cooldown (exit 0) does not fail the group', () => {
    expect(runGroup({ otis: 0, alcon: 0, bossard: 0 })).toBe(0);
  });

  it('a real failure of any member still fails the group', () => {
    expect(runGroup({ otis: 0, alcon: 0, broken: 1 })).toBe(1);
    expect(runGroup({ otis: 0, alcon: 0, killed: 124 })).toBe(1);
  });
});

describe('crawler-health with a Workday cooldown (#20279)', () => {
  const NOW = Date.parse('2026-11-28T12:00:00.000Z');
  const record = (overrides = {}) => ({
    tenant: TENANT,
    firstRateLimitedAt: new Date(NOW - 7 * HOUR).toISOString(),
    lastRateLimitedAt: new Date(NOW - HOUR).toISOString(),
    consecutiveRuns: 2,
    nextAttemptAfter: new Date(NOW + 11 * HOUR).toISOString(),
    outcome: 'rate-limited-cooldown',
    ...overrides,
  });
  const observation = (workdayRateLimit: unknown) => ({
    slug: 'alcon',
    freshnessAt: new Date(NOW - 60_000).toISOString(),
    freshnessSource: 'summary',
    jobCount: 0,
    lastFetchOutcome: 'exhausted_retry',
    abortKind: 'retryable-http-response',
    earlyExit: true,
    exitCode: 0,
    workdayRateLimit,
  });
  const previous = { consecutiveEmptyRuns: 2, lastSuccessfulRunAt: new Date(NOW - 2 * 24 * HOUR).toISOString() };

  it('classifies the declared cooldown as rate-limited-cooldown, not broken, and keeps the streak', () => {
    const { status, reason, state } = nextCrawlerState(previous, observation(record()), new Date(NOW).toISOString(), NOW);

    expect(status).toBe('rate-limited-cooldown');
    expect(reason).toContain('next attempt after');
    expect(reason).toContain(record().nextAttemptAfter);
    expect(reason).toContain('abortKind=retryable-http-response');
    expect(state.consecutiveEmptyRuns).toBe(2);
  });

  it('without the record the same run is broken (control)', () => {
    const { status } = nextCrawlerState(previous, observation(null), new Date(NOW).toISOString(), NOW);
    expect(status).toBe('broken');
  });

  it('stops being lenient once the series is older than the transport floor', () => {
    const old = record({ firstRateLimitedAt: new Date(NOW - 11 * 24 * HOUR).toISOString() });
    const { status } = nextCrawlerState(previous, observation(old), new Date(NOW).toISOString(), NOW);
    expect(status).toBe('broken');
  });

  it('a healthy run with jobs is healthy even if a stale record is present', () => {
    const { status } = nextCrawlerState(previous, { ...observation(record()), jobCount: 12, earlyExit: false }, new Date(NOW).toISOString(), NOW);
    expect(status).toBe('healthy');
  });

  it('the aggregate issue stays open for cooldown members and lists the next attempt per tenant', () => {
    const member = (slug: string, next: string) => ({
      slug,
      status: 'rate-limited-cooldown',
      reason: `tenant x (abortKind=retryable-http-response) next attempt after ${next}`,
      abortKind: 'retryable-http-response',
      rateLimit: record({ nextAttemptAfter: next, tenant: `https://${slug}.wd3.myworkdayjobs.com/wday/cxs/${slug}/c` }),
    });
    const issue = buildAggregateIssue({
      family: 'workday',
      abortKind: 'retryable-http-response',
      repairPoint: 'scripts/lib/ats-clients/workday-client.mjs',
      members: [member('ferring', '2026-11-29T00:00:00.000Z'), member('alcon', '2026-11-28T18:00:00.000Z')] as never,
    });

    expect(issue.status).toBe('rate-limited-cooldown');
    expect(issue.body).toContain('## Prossimi tentativi');
    expect(issue.body).toContain('`alcon` — tenant `https://alcon.wd3.myworkdayjobs.com/wday/cxs/alcon/c`: prossimo tentativo dopo 2026-11-28T18:00:00.000Z');
    expect(issue.body).toContain('2026-11-29T00:00:00.000Z');
  });
});
