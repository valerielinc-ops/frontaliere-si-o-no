import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  CRAWLER_GROUP_LIVE_LEASE_TTL_MS,
  CRAWLER_GROUP_LIVE_LEASE_WAIT_MS,
  LIVE_RUN_QUERY_TIMEOUT_MS,
  crawlerGroupLeaseDoc,
  hasLiveRun,
  parseArgs,
  persistLeaseOwnership,
  releaseGuard,
  runGuard,
} from '../scripts/check-crawler-group-live-run.mjs';

describe('cross-entry crawler live-run guard', () => {
  it('uses the corpus workflow and token defaults, with explicit overrides available', () => {
    expect(parseArgs(['crawler-group-19.yml'])).toEqual({
      groupFile: 'crawler-group-19.yml',
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      tokenEnv: 'GITHUB_PAT_NANAKO',
      action: 'acquire',
    });
    expect(parseArgs([
      'crawler-group-19.yml',
      '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      '--token-env', 'GITHUB_PAT',
    ])).toEqual({
      groupFile: 'crawler-group-19.yml',
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      tokenEnv: 'GITHUB_PAT',
      action: 'acquire',
    });
    expect(parseArgs(['crawler-group-19.yml', '--release']).action).toBe('release');
  });

  it('uses one Firestore document per group and a lease longer than the job cap', () => {
    expect(crawlerGroupLeaseDoc('crawler-group-19.yml')).toBe('ci_leases/crawler-group-live-19');
    expect(() => crawlerGroupLeaseDoc('../crawler-group-19.yml')).toThrow();
    expect(CRAWLER_GROUP_LIVE_LEASE_WAIT_MS).toBe(0);
    expect(CRAWLER_GROUP_LIVE_LEASE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('blocks when the other entry point is queued or active', () => {
    const gh = vi.fn().mockReturnValue(JSON.stringify([
      { workflow_runs: [{ status: 'completed' }] },
      { workflow_runs: [{ status: 'waiting' }] },
    ]));

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(true);
    expect(gh).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        'repos/nanakokyobashi-rgb/frontaliere-articles/actions/workflows/crawler-group-19.yml/runs?per_page=100',
      ],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: LIVE_RUN_QUERY_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        env: expect.objectContaining({ GH_TOKEN: 'token-for-test' }),
      }),
    );
  });

  it('does not block once all runs have completed', () => {
    const gh = vi.fn().mockReturnValue(JSON.stringify([
      { workflow_runs: [{ status: 'completed' }, { status: 'cancelled' }] },
      { workflow_runs: [{ status: 'failure' }] },
    ]));

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(false);
  });

  it('finds a live run on a later API page instead of truncating the listing', () => {
    const gh = vi.fn().mockReturnValue(JSON.stringify([
      { workflow_runs: Array.from({ length: 100 }, () => ({ status: 'completed' })) },
      { workflow_runs: [{ status: 'in_progress' }] },
    ]));

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(true);
  });

  it('proceeds safely when credentials, gh, or JSON data are unavailable', () => {
    const gh = vi.fn().mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: '',
      gh,
    })).toBe(false);
    expect(gh).not.toHaveBeenCalled();

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
    })).toBe(false);

    const malformed = vi.fn().mockReturnValue('{not-json');
    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh: malformed,
    })).toBe(false);
  });

  it('makes a timeout an observable bounded fail-open path', () => {
    const logger = { warn: vi.fn() };
    const gh = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('subprocess timed out'), { code: 'ETIMEDOUT' });
    });

    expect(hasLiveRun('crawler-group-19.yml', {
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      gh,
      logger,
    })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 30000ms'));
  });

  it('acquires before probing, holds ownership for the job, and releases on completion', async () => {
    const order: string[] = [];
    const acquire = vi.fn(async (options) => {
      order.push(`acquire:${options.leaseDoc}`);
      return { acquired: true, busy: false };
    });
    const probe = vi.fn(async () => {
      order.push('probe');
      return false;
    });
    const persist = vi.fn(() => {
      order.push('persist');
      return true;
    });
    const release = vi.fn(async (options) => {
      order.push(`release:${options.leaseDoc}`);
      return { released: true };
    });

    await expect(runGuard({
      groupFile: 'crawler-group-19.yml',
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      acquire,
      probe,
      persist,
      release,
    })).resolves.toMatchObject({ proceed: true, leaseOwned: true });
    expect(order).toEqual([
      'acquire:ci_leases/crawler-group-live-19',
      'probe',
      'persist',
    ]);
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      leaseDoc: 'ci_leases/crawler-group-live-19',
      ttlMs: CRAWLER_GROUP_LIVE_LEASE_TTL_MS,
      waitMs: 0,
    }));

    await expect(releaseGuard({
      groupFile: 'crawler-group-19.yml',
      release,
    })).resolves.toMatchObject({ released: true });
    expect(order.at(-1)).toBe('release:ci_leases/crawler-group-live-19');
  });

  it('fails closed on an occupied lease and does not probe or release it', async () => {
    const probe = vi.fn();
    const release = vi.fn();
    await expect(runGuard({
      groupFile: 'crawler-group-19.yml',
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      token: 'token-for-test',
      acquire: vi.fn(async () => ({ acquired: false, busy: true })),
      probe,
      release,
      logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
    })).resolves.toMatchObject({ proceed: false, reason: 'lease-busy' });
    expect(probe).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('writes an ownership marker only for the always-run release step', () => {
    const envPath = '/tmp/crawler-group-live-lease-test.env';
    persistLeaseOwnership('ci_leases/crawler-group-live-19', envPath);
    expect(fs.readFileSync(envPath, 'utf8')).toBe([
      'CRAWLER_GROUP_LIVE_LEASE_OWNED=1',
      'CRAWLER_GROUP_LIVE_LEASE_DOC=ci_leases/crawler-group-live-19',
      '',
    ].join('\n'));
    fs.unlinkSync(envPath);
  });
});
