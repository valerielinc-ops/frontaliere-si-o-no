import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  collectRepairQuotaStats,
  GH_READ_RETRY_DELAYS_MS,
  GH_READ_TIMEOUT_MS,
  INITIAL_REPAIR_ALLOWANCE,
  main,
  realRunCount,
  repairQuotaDecision,
  repairWorkflowFromRef,
  REPAIR_TO_ISSUE_RATIO_MAX,
  REPAIR_WORKFLOWS,
  runGhJsonBounded,
} from '../scripts/ci/repair-quota-admission.mjs';

const ACTION = readFileSync(
  resolve(__dirname, '..', '.github', 'actions', 'claude-codex-fallback', 'action.yml'),
  'utf8',
);
const ISSUE_FIX = readFileSync(
  resolve(__dirname, '..', '.github', 'workflows', 'issue-fix.yml'),
  'utf8',
);
const DRAINER = readFileSync(
  resolve(__dirname, '..', '.github', 'workflows', 'followup-drainer.yml'),
  'utf8',
);

describe('repairQuotaDecision', () => {
  it('does not hold repairs when the issue-fix queue is empty', () => {
    expect(repairQuotaDecision({ repairRuns: 598, issueFixRuns: 0, queuedIssues: 0 }).admit).toBe(true);
  });

  it('allows the initial bounded repair allowance', () => {
    const decision = repairQuotaDecision({
      repairRuns: INITIAL_REPAIR_ALLOWANCE,
      issueFixRuns: 0,
      queuedIssues: 209,
    });
    expect(decision.admit).toBe(true);
    expect(decision.requiredIssueFixRuns).toBe(0);
  });

  it('holds the observed 598:24 allocation while work is queued', () => {
    const decision = repairQuotaDecision({ repairRuns: 598, issueFixRuns: 24, queuedIssues: 209 });
    expect(decision.admit).toBe(false);
    expect(decision.requiredIssueFixRuns).toBe(Math.ceil(598 / REPAIR_TO_ISSUE_RATIO_MAX));
    expect(decision.reason).toContain('issue-fix floor missing');
  });

  it('releases the frontier once issue-fix catches up to the 7:1 floor', () => {
    expect(repairQuotaDecision({ repairRuns: 598, issueFixRuns: 86, queuedIssues: 209 }).admit).toBe(true);
    expect(repairQuotaDecision({ repairRuns: 603, issueFixRuns: 86, queuedIssues: 209 }).admit).toBe(false);
  });

  it('counts active shared leases exactly once in the allocation frontier', () => {
    expect(repairQuotaDecision({
      repairRuns: 7,
      issueFixRuns: 1,
      activeRepairLeases: 1,
      queuedIssues: 1,
    }).admit).toBe(false);
    expect(repairQuotaDecision({
      repairRuns: 7,
      issueFixRuns: 1,
      activeRepairLeases: 1,
      activeIssueFixLeases: 1,
      queuedIssues: 1,
    }).admit).toBe(true);
  });
});

describe('telemetry helpers', () => {
  it('uses the same cancelled/skipped exclusion as loop-health-report', () => {
    expect(realRunCount([
      { conclusion: 'success' },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { conclusion: 'skipped' },
    ])).toBe(2);
    expect(realRunCount(null)).toBeNull();
    expect(realRunCount([{ status: 'in_progress' }, { conclusion: 'success' }], { excludeActive: true })).toBe(1);
  });

  it('collects both repair workflows, issue-fix, and the queued issue count', () => {
    const seen: string[][] = [];
    const runJson = (args: string[]) => {
      seen.push(args);
      if (args[0] === 'issue') return [{ number: 8307 }, { number: 8145 }];
      if (args[0] === 'api') return [];
      if (args.includes('issue-fix.yml')) return [{ conclusion: 'success' }, { conclusion: 'cancelled' }];
      if (args.includes('pr-redflag-fixer.yml')) return [{ conclusion: 'failure' }];
      if (args.includes('pr-redcheck-fixer.yml')) return [{ conclusion: 'success' }, { conclusion: 'skipped' }];
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const stats = collectRepairQuotaStats({ repo: 'owner/repo', since: '2026-09-05', runJson });
    expect(stats).toMatchObject({
      ok: true,
      since: '2026-09-05',
      repairRuns: 2,
      issueFixRuns: 1,
      queuedIssues: 2,
      activeRepairLeases: 0,
      activeIssueFixLeases: 0,
    });
    expect(stats.floor).toMatchObject({ ok: true, activeLeases: [], activeCounts: { repair: 0, 'issue-fix': 0 } });
    expect(seen).toHaveLength(REPAIR_WORKFLOWS.length + 3);
  });

  it('retries a transient paginated Actions 504 within a per-read deadline', () => {
    const calls: string[][] = [];
    const timeouts: number[] = [];
    const delays: number[] = [];
    let failedOnce = false;
    const runJson = (args: string[]) => runGhJsonBounded(args, {
      execute: (_binary: string, cliArgs: string[], options: { timeout?: number }) => {
        calls.push(cliArgs);
        timeouts.push(options.timeout || 0);
        if (!failedOnce && cliArgs[0] === 'run' && cliArgs.includes('pr-redflag-fixer.yml')) {
          failedOnce = true;
          throw Object.assign(new Error('Command failed: gh run list'), {
            status: 1,
            stderr: Buffer.from('failed to get runs: HTTP 504: upstream timed out'),
          });
        }
        return JSON.stringify([]);
      },
      sleep: (delayMs: number) => { delays.push(delayMs); },
      warn: () => {},
    });

    const stats = collectRepairQuotaStats({ repo: 'owner/repo', since: '2026-10-08', runJson });

    expect(stats).toMatchObject({ ok: true, repairRuns: 0, issueFixRuns: 0, queuedIssues: 0 });
    expect(calls).toHaveLength(REPAIR_WORKFLOWS.length + 4);
    expect(calls[0]).toEqual(calls[1]);
    expect(timeouts).toEqual(Array(calls.length).fill(GH_READ_TIMEOUT_MS));
    expect(delays).toEqual([GH_READ_RETRY_DELAYS_MS[0]]);
  });

  it('fails quota admission closed after the bounded retries are exhausted', () => {
    let attempts = 0;
    const delays: number[] = [];
    const runJson = (args: string[]) => runGhJsonBounded(args, {
      execute: () => {
        attempts += 1;
        throw Object.assign(new Error('Command failed: gh run list'), {
          status: 1,
          stderr: Buffer.from('failed to get runs: HTTP 504: upstream timed out'),
        });
      },
      sleep: (delayMs: number) => { delays.push(delayMs); },
      warn: () => {},
    });

    const result = main({
      env: {
        GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/pr-redcheck-fixer.yml@refs/heads/main',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '7310',
      },
      runJson,
      runCommand: () => { throw new Error('must not mutate'); },
    });

    expect(result).toMatchObject({ admit: false, held: false });
    expect(result.reason).toContain('HTTP 504');
    expect(attempts).toBe(GH_READ_RETRY_DELAYS_MS.length + 1);
    expect(delays).toEqual([...GH_READ_RETRY_DELAYS_MS]);
  });

  it.each(['403: Resource not accessible', '501: Not Implemented'])(
    'does not retry non-transient GitHub read failures (%s)',
    (failure) => {
      let attempts = 0;
      expect(() => runGhJsonBounded(['run', 'list'], {
        execute: () => {
          attempts += 1;
          throw Object.assign(new Error(`HTTP ${failure}`), {
            status: 1,
            stderr: Buffer.from(`HTTP ${failure}`),
          });
        },
        sleep: () => {},
        warn: () => {},
      })).toThrow(new RegExp(`HTTP ${failure.split(':')[0]}`, 'u'));
      expect(attempts).toBe(1);
    },
  );

  it('fails closed when a telemetry listing is malformed', () => {
    expect(collectRepairQuotaStats({
      repo: 'owner/repo',
      runJson: () => ({ nope: true }),
    }).ok).toBe(false);
  });

  it('recognizes only the two PR repair workflow refs', () => {
    expect(repairWorkflowFromRef('owner/repo/.github/workflows/pr-redflag-fixer.yml@refs/heads/main'))
      .toBe('pr-redflag-fixer.yml');
    expect(repairWorkflowFromRef('owner/repo/.github/workflows/pr-redcheck-fixer.yml@refs/heads/main'))
      .toBe('pr-redcheck-fixer.yml');
    expect(repairWorkflowFromRef('owner/repo/.github/workflows/tests.yml@refs/heads/main')).toBe('');
  });

  it('refunds a held round only after finding and deleting its current marker', () => {
    const commands: string[][] = [];
    const runJson = (args: string[]) => {
      if (args[0] === 'run') {
        if (args.includes('pr-redflag-fixer.yml')) return Array.from({ length: 598 }, () => ({ conclusion: 'success' }));
        if (args.includes('pr-redcheck-fixer.yml')) return [];
        if (args.includes('issue-fix.yml')) return Array.from({ length: 24 }, () => ({ conclusion: 'success' }));
      }
      if (args[0] === 'issue') return Array.from({ length: 209 }, (_, number) => ({ number }));
      if (args[0] === 'pr' && args[1] === 'view') return { headRefOid: 'abcdef1234567890' };
      if (args[0] === 'api' && args[1].startsWith('repos/')) {
        return [[{ id: 77, body: '<!-- REDFLAG_FIX_ROUND: 1 -->\n_🔴-fixer round 1/2 avviato (auto)._'}]];
      }
      throw new Error(`unexpected gh read: ${args.join(' ')}`);
    };

    const result = main({
      env: {
        GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/pr-redflag-fixer.yml@refs/heads/main',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '123',
        FIX_ROUND: '1',
      },
      runJson,
      runCommand: (args) => { commands.push(args); },
      now: Date.parse('2026-09-12T12:00:00Z'),
    });

    expect(result).toMatchObject({ admit: false, held: true });
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ['pr', 'edit', '123'],
      ['pr', 'comment', '123'],
      ['api', '--method', 'DELETE'],
      ['pr', 'comment', '123'],
    ]);
    expect(commands[1].join('\n')).toContain('zero-Claude');
    expect(commands[3].join('\n')).toContain('REPAIR_QUOTA_REFUND');
  });

  it('acquires a shared lease before admitting the first repair provider attempt', () => {
    const commands: string[][] = [];
    const runJson = (args: string[]) => {
      if (args[0] === 'run') return [];
      if (args[0] === 'issue' && args[1] === 'list') return [{ number: 8307 }];
      if (args[0] === 'api') return [];
      throw new Error(`unexpected gh read: ${args.join(' ')}`);
    };
    const result = main({
      env: {
        GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/pr-redflag-fixer.yml@refs/heads/main',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '123',
        FIX_ROUND: '1',
        GITHUB_RUN_ID: 'run-123',
        GITHUB_RUN_ATTEMPT: '1',
      },
      runJson,
      runCommand: (args) => { commands.push(args); return JSON.stringify({ id: 88 }); },
      now: Date.parse('2026-09-12T12:00:00Z'),
    });

    expect(result).toMatchObject({ admit: true, held: false });
    expect(result.leaseAcquired).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].join(' ')).toContain('QUOTA_FLOOR_LEASE');
    expect(commands[0].join(' ')).toContain('subject=pr-123');
  });

  it.each([
    ['redflag', 'current body', 'HEAD_BODY', 'current', 'current', 'trusted', true],
    ['redcheck', 'current body', 'HEAD_BODY', 'current', 'current', 'trusted', true],
    ['redflag', 'head-only compatibility', 'HEAD', 'current', '', 'trusted', true],
    ['redcheck', 'head-only compatibility', 'HEAD', 'current', '', 'trusted', true],
    ['redflag', 'different head', 'HEAD_BODY', 'other', 'current', 'trusted', false],
    ['redflag', 'different body', 'HEAD_BODY', 'current', 'other', 'trusted', false],
    ['redflag', 'missing expected body', 'MISSING_EXPECTED_REVISION', 'current', 'current', 'trusted', false],
    ['redflag', 'untrusted author', 'HEAD_BODY', 'current', 'current', 'human', false],
    ['redcheck', 'different round', 'ROUND_10', 'current', 'current', 'trusted', false],
    ['redflag', 'malformed head', 'HEAD_BODY', 'malformed', 'current', 'trusted', false],
    ['redflag', 'malformed body', 'HEAD_BODY', 'current', 'malformed', 'trusted', false],
    ['redflag', 'legacy marker cannot override a different scoped head', 'LEGACY_AND_OTHER', 'other', 'current', 'trusted', false],
  ] as const)('holds %s safely: %s', (kind, _case, format, head, revision, author, held) => {
    const sha = 'a'.repeat(40);
    const expectedRevision = `body:${'b'.repeat(64)}`;
    const markerHead = head === 'current' ? sha : head === 'other' ? 'c'.repeat(40) : 'not-a-sha';
    const markerRevision = revision === 'current' ? expectedRevision : revision === 'other' ? `body:${'d'.repeat(64)}` : 'invalid';
    const marker = kind === 'redcheck' ? 'REDCHECK_FIX_ROUND' : 'REDFLAG_FIX_ROUND';
    const round = format === 'ROUND_10' ? 10 : 1;
    const body = `<!-- ${marker}: ${round} HEAD: ${markerHead}${format === 'HEAD' ? '' : ` BODY: ${markerRevision}`} -->\n_round started_`;
    const comments = [{ id: 77, body, user: { login: author === 'trusted' ? 'github-actions[bot]' : 'someone', type: author === 'trusted' ? 'Bot' : 'User' } }];
    if (format === 'LEGACY_AND_OTHER') comments.push({ ...comments[0], id: 88, body: `<!-- ${marker}: 1 -->\n_old unscoped round_` });
    const commands: string[][] = [];
    const result = main({
      env: { GITHUB_WORKFLOW_REF: `owner/repo/.github/workflows/pr-${kind}-fixer.yml@refs/heads/main`, GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '123', FIX_ROUND: '1', PR_BODY_EXPECTED_REVISION: format === 'MISSING_EXPECTED_REVISION' ? undefined : expectedRevision },
      runJson: (args: string[]) => {
        if (args[0] === 'run') return args.includes('pr-redflag-fixer.yml') ? Array.from({ length: 14 }, () => ({ conclusion: 'success' })) : [];
        if (args[0] === 'issue') return [{ number: 1 }];
        if (args[0] === 'pr') return { headRefOid: sha };
        if (args[0] === 'api') return [comments];
        throw new Error(`unexpected read: ${args.join(' ')}`);
      },
      runCommand: (args: string[]) => { commands.push(args); },
      now: Date.now(),
    });
    expect(result).toMatchObject({ admit: false, held });
    if (held) {
      expect(commands).toHaveLength(4);
      expect(commands[0]).toContain('stale-review');
      expect(commands[2]).toEqual(['api', '--method', 'DELETE', 'repos/owner/repo/issues/comments/77']);
    } else {
      expect(commands).toEqual([]);
      expect(result.reason).toContain('current round marker missing');
    }
  });

  it('blocks a repair when the shared ledger cannot be read', () => {
    const result = main({
      env: {
        GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/pr-redflag-fixer.yml@refs/heads/main',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '123',
      },
      runJson: () => { throw new Error('ledger offline'); },
      runCommand: () => { throw new Error('must not mutate'); },
      now: Date.parse('2026-09-12T12:00:00Z'),
    });
    expect(result).toMatchObject({ admit: false, held: false });
    expect(result.reason).toContain('unavailable');
  });
});

describe('provider-neutral action wiring', () => {
  it('runs the admission before trusted runtime setup and never starts a provider on hold', () => {
    const admission = ACTION.indexOf('id: repair_quota');
    const trusted = ACTION.indexOf('id: trusted_node');
    const codex = ACTION.indexOf('id: codex');
    expect(admission).toBeGreaterThan(0);
    expect(admission).toBeLessThan(trusted);
    expect(trusted).toBeLessThan(codex);
    expect(ACTION).not.toContain('\n      id: claude');
    expect(ACTION).toContain("if: steps.repair_quota.outputs.admit == 'true'");
    expect(ACTION).toContain('REPAIR_QUOTA_HELD: ${{ steps.repair_quota.outputs.held }}');
    expect(ACTION).toContain('stale-review');
    expect(ACTION).toContain('Release repair quota-floor lease (zero-Claude)');
    expect(ACTION).toContain('QUOTA_FLOOR_OWNER: ${{ steps.repair_quota.outputs.lease_owner }}');
  });

  it('gates issue-fix before npm/provider work and keeps max-turns and Auto Ads unchanged', () => {
    expect(ISSUE_FIX).toContain("QUOTA_FLOOR_REQUIRED: '1'");
    expect(ISSUE_FIX).not.toContain('QUOTA_FLOOR_LEDGER_ISSUE:');
    expect(ACTION).not.toContain('QUOTA_FLOOR_LEDGER_ISSUE:');
    expect(DRAINER).not.toContain('QUOTA_FLOOR_LEDGER_ISSUE:');
    expect(ISSUE_FIX).toContain('Enforce shared quota-floor lease (fail-closed)');
    expect(ISSUE_FIX.indexOf('Enforce shared quota-floor lease (fail-closed)'))
      .toBeLessThan(ISSUE_FIX.indexOf('- name: Install dependencies'));
    expect(ISSUE_FIX).toContain("if: steps.quota.outputs.quota_floor_admit == 'true'");
    expect(ISSUE_FIX).toContain("if: always() && steps.issue_snapshot.outputs.verified == 'true' && steps.quota.outputs.quota_floor_lease_owned == 'true'");
    expect(ISSUE_FIX).toContain('id: codex_fix');
    expect(ISSUE_FIX).toContain('codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(ISSUE_FIX).not.toContain('claude_args:');
    expect(ISSUE_FIX).toContain('Mai disabilitare AdSense Auto Ads');
  });
});
