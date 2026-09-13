import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  collectRepairQuotaStats,
  INITIAL_REPAIR_ALLOWANCE,
  main,
  realRunCount,
  repairQuotaDecision,
  repairWorkflowFromRef,
  REPAIR_TO_ISSUE_RATIO_MAX,
  REPAIR_WORKFLOWS,
} from '../scripts/ci/repair-quota-admission.mjs';

const ACTION = readFileSync(
  resolve(__dirname, '..', '.github', 'actions', 'claude-codex-fallback', 'action.yml'),
  'utf8',
);
const ISSUE_FIX = readFileSync(
  resolve(__dirname, '..', '.github', 'workflows', 'issue-fix.yml'),
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
      runCommand: (args) => { commands.push(args); },
      now: Date.parse('2026-09-12T12:00:00Z'),
    });

    expect(result).toMatchObject({ admit: true, held: false });
    expect(result.leaseAcquired).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].join(' ')).toContain('QUOTA_FLOOR_LEASE');
    expect(commands[0].join(' ')).toContain('subject=pr-123');
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
    const claude = ACTION.indexOf('id: claude');
    expect(admission).toBeGreaterThan(0);
    expect(admission).toBeLessThan(trusted);
    expect(trusted).toBeLessThan(codex);
    expect(codex).toBeLessThan(claude);
    expect(ACTION).toContain("if: steps.repair_quota.outputs.admit == 'true'");
    expect(ACTION).toContain('REPAIR_QUOTA_HELD: ${{ steps.repair_quota.outputs.held }}');
    expect(ACTION).toContain('stale-review');
    expect(ACTION).toContain('Release repair quota-floor lease (zero-Claude)');
    expect(ACTION).toContain('QUOTA_FLOOR_OWNER: ${{ steps.repair_quota.outputs.lease_owner }}');
  });

  it('gates issue-fix before npm/provider work and keeps max-turns and Auto Ads unchanged', () => {
    expect(ISSUE_FIX).toContain("QUOTA_FLOOR_REQUIRED: '1'");
    expect(ISSUE_FIX).toContain('Enforce shared quota-floor lease (fail-closed)');
    expect(ISSUE_FIX.indexOf('Enforce shared quota-floor lease (fail-closed)'))
      .toBeLessThan(ISSUE_FIX.indexOf('- name: Install dependencies'));
    expect(ISSUE_FIX).toContain("if: steps.quota.outputs.quota_floor_admit == 'true'");
    expect(ISSUE_FIX).toContain(
      'claude_args: "--effort medium --max-turns ${{ steps.tier.outputs.max_turns }}',
    );
    expect(ISSUE_FIX).toContain('Mai disabilitare AdSense Auto Ads');
  });
});
