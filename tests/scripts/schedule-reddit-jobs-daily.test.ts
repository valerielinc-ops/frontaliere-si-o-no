import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pure-ESM script. The CLI block is gated on `import.meta.url ===
// file://${process.argv[1]}`, so importing is side-effect-free.
import * as scheduler from '../../scripts/schedule-reddit-jobs-daily.mjs';

interface JobLike {
  id: string;
  title?: string;
  titleByLocale?: Record<string, string>;
  slug?: string;
  slugByLocale?: Record<string, string>;
  jobLocation?: { address?: { addressLocality?: string } };
  description?: string;
  descriptionByLocale?: Record<string, string>;
  employmentType?: string;
  firstSeenAt?: string;
  crawledAt?: string;
}

interface SubConfig {
  allowsAutomation: boolean;
  minPostIntervalHours?: number;
  flairId?: string | null;
  flairText?: string | null;
  topics?: string[];
}

interface RedditConfig {
  schemaVersion: number;
  subreddits: Record<string, SubConfig>;
  routing: Record<string, string[]>;
}

interface PostedEntry {
  id: string;
  url: string;
  subreddit: string;
  ts: string;
  redditPostId?: string;
}

interface PostedLedger {
  schemaVersion: number;
  posted: PostedEntry[];
}

interface Payload {
  jobId: string;
  url: string;
  subreddit: string;
  title: string;
  kind: string;
  text: string;
}

const {
  eligibleSubsForTopic,
  isRateLimited,
  loadSubreddits,
  selectUnpostedJobs,
  buildJobUrl,
  run,
} = scheduler as unknown as {
  eligibleSubsForTopic: (
    config: RedditConfig,
    topic: string,
  ) => Array<{ name: string; config: SubConfig }>;
  isRateLimited: (
    ledgerPosted: PostedEntry[],
    subreddit: string,
    minIntervalHours: number | undefined,
    now: Date | number,
  ) => boolean;
  loadSubreddits: (repoRoot: string) => RedditConfig;
  selectUnpostedJobs: (
    jobs: JobLike[],
    postedSet: Set<string>,
    limit: number,
  ) => JobLike[];
  buildJobUrl: (job: JobLike) => string | null;
  run: (opts: {
    env?: Record<string, string | undefined>;
    now?: Date;
    repoRoot?: string;
    fetchImpl?: typeof fetch;
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  }) => Promise<{
    ok: boolean;
    posted: number;
    dryRun: boolean;
    payloads: Payload[];
  }>;
};

// ── Fixtures helpers ──────────────────────────────────────

// CRITICAL project rule: never hardcode absolute dates in fixtures. All
// timestamps are relative to a fixed `now` we pass into run()/helpers.
const NOW = new Date('2026-06-15T12:00:00Z');
function daysAgo(n: number, base: Date = NOW): string {
  return new Date(base.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}
function hoursAgo(n: number, base: Date = NOW): string {
  return new Date(base.getTime() - n * 60 * 60 * 1000).toISOString();
}

// A controlled subreddit config: one automation-enabled sub, one disabled.
const CONFIG: RedditConfig = {
  schemaVersion: 1,
  subreddits: {
    frontalieri: {
      allowsAutomation: true,
      minPostIntervalHours: 6,
      flairId: null,
      flairText: null,
      topics: ['jobs', 'articles'],
    },
    Ticino: {
      allowsAutomation: false,
      minPostIntervalHours: 24,
      flairId: null,
      flairText: null,
      topics: ['jobs', 'articles'],
    },
  },
  routing: { jobs: ['frontalieri', 'Ticino'], articles: ['frontalieri', 'Ticino'] },
};

function makeJob(id: string, ageDays: number, overrides: Partial<JobLike> = {}): JobLike {
  return {
    id,
    title: `Lavoro ${id}`,
    slugByLocale: { it: `lavoro-${id}` },
    jobLocation: { address: { addressLocality: 'Lugano' } },
    descriptionByLocale: { it: `Descrizione per ${id}.` },
    employmentType: 'FULL_TIME',
    crawledAt: daysAgo(ageDays),
    ...overrides,
  };
}

function setupTmp(opts: {
  jobs: JobLike[];
  posted?: PostedEntry[];
  config?: RedditConfig;
}): string {
  const tmp = mkdtempSync(join(tmpdir(), 'reddit-jobs-'));
  mkdirSync(join(tmp, 'data'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'jobs.json'), JSON.stringify(opts.jobs));
  writeFileSync(
    join(tmp, 'data', 'reddit-subreddits.json'),
    JSON.stringify(opts.config ?? CONFIG),
  );
  writeFileSync(
    join(tmp, 'data', 'reddit-posted-jobs.json'),
    JSON.stringify({ schemaVersion: 1, posted: opts.posted ?? [] }),
  );
  return tmp;
}

function loadLedger(repoRoot: string): PostedLedger {
  return JSON.parse(
    readFileSync(join(repoRoot, 'data', 'reddit-posted-jobs.json'), 'utf-8'),
  );
}

// A fetch mock that emulates Reddit's token + submit endpoints.
function makeFetchMock() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (u.includes('/api/submit')) {
      return new Response(
        JSON.stringify({
          json: {
            errors: [],
            data: { id: 'abc', name: 't3_abc', url: 'https://reddit.com/r/frontalieri/comments/abc/' },
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
}

const CREDS = {
  REDDIT_CLIENT_ID: 'cid',
  REDDIT_CLIENT_SECRET: 'csecret',
  REDDIT_USERNAME: 'bot',
  REDDIT_PASSWORD: 'pw',
  REDDIT_USER_AGENT: 'web:test:v1.0 (by /u/test)',
};

// ── eligibleSubsForTopic ──────────────────────────────────

describe('eligibleSubsForTopic', () => {
  it('returns only allowsAutomation:true subs routed for the topic', () => {
    const out = eligibleSubsForTopic(CONFIG, 'jobs');
    expect(out.map((s) => s.name)).toEqual(['frontalieri']);
    expect(out[0].config.allowsAutomation).toBe(true);
  });

  it('returns [] for a topic with no routing', () => {
    expect(eligibleSubsForTopic(CONFIG, 'nope')).toEqual([]);
  });

  it('returns [] when no routed sub is automation-enabled', () => {
    const cfg: RedditConfig = {
      ...CONFIG,
      subreddits: { Ticino: { allowsAutomation: false } },
      routing: { jobs: ['Ticino'] },
    };
    expect(eligibleSubsForTopic(cfg, 'jobs')).toEqual([]);
  });
});

// ── isRateLimited ─────────────────────────────────────────

describe('isRateLimited', () => {
  it('is true when the last post is within minIntervalHours of now', () => {
    const posted: PostedEntry[] = [
      { id: 'x', url: 'u', subreddit: 'frontalieri', ts: hoursAgo(2) },
    ];
    expect(isRateLimited(posted, 'frontalieri', 6, NOW)).toBe(true);
  });

  it('is false when the last post is older than minIntervalHours', () => {
    const posted: PostedEntry[] = [
      { id: 'x', url: 'u', subreddit: 'frontalieri', ts: hoursAgo(10) },
    ];
    expect(isRateLimited(posted, 'frontalieri', 6, NOW)).toBe(false);
  });

  it('is false when the sub was never posted to', () => {
    const posted: PostedEntry[] = [
      { id: 'x', url: 'u', subreddit: 'other', ts: hoursAgo(1) },
    ];
    expect(isRateLimited(posted, 'frontalieri', 6, NOW)).toBe(false);
  });

  it('is false when minIntervalHours is 0/undefined (limit disabled)', () => {
    const posted: PostedEntry[] = [
      { id: 'x', url: 'u', subreddit: 'frontalieri', ts: hoursAgo(0.1) },
    ];
    expect(isRateLimited(posted, 'frontalieri', 0, NOW)).toBe(false);
    expect(isRateLimited(posted, 'frontalieri', undefined, NOW)).toBe(false);
  });

  it('uses the most recent entry when several exist', () => {
    const posted: PostedEntry[] = [
      { id: 'old', url: 'u', subreddit: 'frontalieri', ts: hoursAgo(20) },
      { id: 'new', url: 'u', subreddit: 'frontalieri', ts: hoursAgo(1) },
    ];
    expect(isRateLimited(posted, 'frontalieri', 6, NOW)).toBe(true);
  });
});

// ── run() — DRY_RUN ───────────────────────────────────────

describe('run() — DRY_RUN', () => {
  it('does not call fetch, returns payloads, leaves the ledger unchanged', async () => {
    // Use a 0-interval sub so multiple jobs can target the same sub in one run
    // (the scheduler enforces minPostIntervalHours per-sub even within a run).
    const cfg: RedditConfig = {
      schemaVersion: 1,
      subreddits: {
        frontalieri: { allowsAutomation: true, minPostIntervalHours: 0 },
        Ticino: { allowsAutomation: false, minPostIntervalHours: 24 },
      },
      routing: { jobs: ['frontalieri', 'Ticino'], articles: ['frontalieri'] },
    };
    const tmp = setupTmp({ jobs: [makeJob('A', 1), makeJob('B', 2)], config: cfg });
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { ...CREDS, DRY_RUN: '1', REDDIT_JOB_VOLUME: '2', REDDIT_POST_DELAY_MS: '0' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.posted).toBe(0);
    expect(result.payloads).toHaveLength(2);
    // Recency: A (1 day ago) before B (2 days ago).
    expect(result.payloads[0].jobId).toBe('A');
    expect(result.payloads[0].subreddit).toBe('frontalieri');
    expect(result.payloads[0].kind).toBe('self');

    expect(loadLedger(tmp).posted).toHaveLength(0);
  });
});

// ── run() — real (mocked network) ─────────────────────────

describe('run() — real posting', () => {
  it('posts up to volume and writes ledger entries with subreddit + redditPostId', async () => {
    const tmp = setupTmp({ jobs: [makeJob('A', 1), makeJob('B', 2), makeJob('C', 3)] });
    const fetchSpy = makeFetchMock();
    const result = await run({
      env: { ...CREDS, REDDIT_JOB_VOLUME: '1', REDDIT_POST_DELAY_MS: '0' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.posted).toBe(1); // volume cap = 1
    expect(result.payloads).toHaveLength(1);

    const ledger = loadLedger(tmp);
    expect(ledger.posted).toHaveLength(1);
    expect(ledger.posted[0].id).toBe('A');
    expect(ledger.posted[0].subreddit).toBe('frontalieri');
    expect(ledger.posted[0].redditPostId).toBe('t3_abc');
  });

  it('dedups jobs already in the ledger', async () => {
    // A is already posted; only B should be picked.
    const tmp = setupTmp({
      jobs: [makeJob('A', 1), makeJob('B', 2)],
      posted: [
        { id: 'A', url: 'u', subreddit: 'frontalieri', ts: daysAgo(5) },
      ],
    });
    const fetchSpy = makeFetchMock();
    const result = await run({
      env: { ...CREDS, REDDIT_JOB_VOLUME: '5', REDDIT_POST_DELAY_MS: '0' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(result.posted).toBe(1);
    expect(result.payloads.map((p) => p.jobId)).toEqual(['B']);

    const ledger = loadLedger(tmp);
    // Original A entry plus the new B entry.
    expect(ledger.posted.map((e) => e.id).sort()).toEqual(['A', 'B']);
  });

  it('posts 0 and leaves the ledger unchanged when no sub is automation-enabled', async () => {
    const cfg: RedditConfig = {
      schemaVersion: 1,
      subreddits: { Ticino: { allowsAutomation: false, minPostIntervalHours: 24 } },
      routing: { jobs: ['Ticino'] },
    };
    const tmp = setupTmp({ jobs: [makeJob('A', 1)], config: cfg });
    const fetchSpy = makeFetchMock();
    const result = await run({
      env: { ...CREDS, REDDIT_JOB_VOLUME: '2', REDDIT_POST_DELAY_MS: '0' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(result.posted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadLedger(tmp).posted).toHaveLength(0);
  });
});

// ── re-exported helpers smoke test ────────────────────────

describe('re-exported helpers', () => {
  it('selectUnpostedJobs and buildJobUrl are re-exported and work', () => {
    const jobs = [makeJob('A', 1), makeJob('B', 2)];
    const out = selectUnpostedJobs(jobs, new Set(['A']), 10);
    expect(out.map((j) => j.id)).toEqual(['B']);
    expect(buildJobUrl(jobs[0])).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/lavoro-A/',
    );
  });

  it('loadSubreddits reads the controlled config from a temp repoRoot', () => {
    const tmp = setupTmp({ jobs: [] });
    const cfg = loadSubreddits(tmp);
    expect(cfg.routing.jobs).toEqual(['frontalieri', 'Ticino']);
    expect(cfg.subreddits.frontalieri.allowsAutomation).toBe(true);
  });
});
