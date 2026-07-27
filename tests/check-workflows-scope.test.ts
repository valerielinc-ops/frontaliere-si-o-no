/**
 * Lock the path-extraction logic of the zero-Claude workflows-scope pre-flight gate
 * (scripts/ci/check-workflows-scope.mjs). Structural fix for escalation #3887,
 * broadened by #4518 (full-body scan, not just backticks/code-blocks).
 *
 * The gate runs BEFORE Claude in issue-fix.yml to short-circuit issues that explicitly
 * cite .github/workflows/** files. It is intentionally CONSERVATIVE (PROCEED-SAFE):
 * only the literal `.github/workflows/<name>.yml`/`.yaml` substring triggers a block —
 * bare .yml names without the prefix, and generic workflow-prose without the literal
 * path, are passed through (the pre-commit hook handles diagnosis-time discoveries).
 *
 * Mode 2 (issue #4227): the recurrence detector's pure predicates (isCiTimeoutIssue,
 * hasBlockedWorkflowsScopeMarker, filterExactTitleRecurrences) — see that module's
 * docstring for the full rationale/evidence. The gh-backed orchestration
 * (findRecentBlockedRecurrence, main) is not unit tested here, matching this file's
 * existing convention (only pure logic is covered; CLI/gh plumbing mirrors
 * check-issue-already-resolved.mjs which is untested for the same reason).
 */
import { describe, it, expect } from 'vitest';
import {
  extractWorkflowPaths,
  isExclusivelyWorkflowScoped,
  isCiTimeoutIssue,
  hasBlockedWorkflowsScopeMarker,
  filterExactTitleRecurrences,
} from '../scripts/ci/check-workflows-scope.mjs';

describe('extractWorkflowPaths — BLOCKED (explicit .github/workflows/** paths)', () => {
  it('detects backtick ref with full .github/workflows/ prefix', () => {
    const body = 'Suggested action: in `.github/workflows/traffic-scheduler.yml`, change the cron.';
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/traffic-scheduler.yml');
  });

  it('detects multiple backtick refs', () => {
    const body = [
      'Edit `.github/workflows/issue-fix.yml` and `.github/workflows/issue-triage.yml`.',
    ].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/issue-fix.yml');
    expect(paths).toContain('.github/workflows/issue-triage.yml');
  });

  it('detects path inside a fenced code block (``` fence)', () => {
    const body = [
      'Change the following file:',
      '```yaml',
      '.github/workflows/post-deploy-validate-dist.yml',
      '```',
    ].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/post-deploy-validate-dist.yml');
  });

  it('detects path inside a ~~~ fenced code block', () => {
    const body = ['~~~', '.github/workflows/crawler-group-01.yml', '~~~'].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/crawler-group-01.yml');
  });

  it('detects "file: .github/workflows/..." annotation inside a code block', () => {
    const body = ['```', '# file: .github/workflows/deploy.yml', '```'].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/deploy.yml');
  });

  it('detects a bare markdown bullet-list path with no backticks/fence (issue #4518, live-sampled #4453)', () => {
    const body = [
      '## File di partenza',
      '',
      '- .github/workflows/update-exchange-history.yml (cron gia attivo)',
      '- build-plugins/borderWaitPagesPlugin.ts (pattern snapshot->SSG)',
    ].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/update-exchange-history.yml');
  });

  it('detects a bare path in plain prose, trimming trailing sentence punctuation', () => {
    const body = 'The fix needs a new step in .github/workflows/traffic-scheduler.yml, then redeploy.';
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/traffic-scheduler.yml');
  });

  it('detects a .yaml (not .yml) extension', () => {
    const body = 'Edit .github/workflows/foo.yaml directly.';
    expect(extractWorkflowPaths(body)).toContain('.github/workflows/foo.yaml');
  });
});

describe('extractWorkflowPaths — PROCEED (no explicit workflow path)', () => {
  it('does NOT trigger on plain prose mentioning "traffic-scheduler workflow"', () => {
    const body = 'The traffic-scheduler workflow has a scheduling gap. Self-heal dispatched traffic-scheduler.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on a bare .yml name without .github/workflows/ prefix', () => {
    const body = 'Fix the rate-limit in `orchestrate-crawlers.yml` dispatch loop.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on prose that mentions "workflows" generically', () => {
    const body = 'The issue-fix workflow was failing. The workflows scope is missing.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on code block with non-workflow .yml files', () => {
    const body = ['```', 'lighthouserc.yml', 'vitest.config.ts', '```'].join('\n');
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on .github/ paths outside workflows/ (e.g. .github/actions/)', () => {
    const body = 'Edit `.github/actions/setup-headroom/action.yml` for the proxy.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('returns empty array for empty/undefined body', () => {
    expect(extractWorkflowPaths('')).toHaveLength(0);
    expect(extractWorkflowPaths(undefined as unknown as string)).toHaveLength(0);
  });
});

describe('isExclusivelyWorkflowScoped — Mode 1 exclusivity gate (issue #4437)', () => {
  it('is true when the body cites ONLY a workflow path', () => {
    const body = 'The fix must edit .github/workflows/deploy.yml timeout-minutes.';
    expect(isExclusivelyWorkflowScoped(body)).toBe(true);
  });

  it('is false when a workflow path is co-cited with a non-workflow code path (#4437 regression)', () => {
    const body = [
      'Fix in scripts/send-job-alerts.mjs: wrap the zero-match createGithubIssue call in try-catch.',
      '',
      '## Live-verification (manuale post-deploy)',
      '- [ ] check .github/workflows/send-job-alerts.yml run succeeded',
    ].join('\n');
    expect(isExclusivelyWorkflowScoped(body)).toBe(false);
  });

  it('is false when there is no workflow path at all', () => {
    const body = 'Fix in scripts/send-job-alerts.mjs: add a try-catch guard.';
    expect(isExclusivelyWorkflowScoped(body)).toBe(false);
  });

  it('is false for an empty/undefined body', () => {
    expect(isExclusivelyWorkflowScoped('')).toBe(false);
    expect(isExclusivelyWorkflowScoped(undefined as unknown as string)).toBe(false);
  });

  it.each([
    ['infra/cloudflare-worker/locale-router.js', 'infra/'],
    ['server/newsletterResendWebhook.js', 'server/'],
    ['functions/index.js', 'functions/ (top-level)'],
    ['functions/src/jobAlertBackfillCore.js', 'functions/src/'],
  ])(
    'is false when a workflow path is co-cited with a %s code path (#4778 review regression)',
    (codePath) => {
      const body = [
        `Fix in ${codePath}: correct the routing logic.`,
        '',
        '## Live-verification (manuale post-deploy)',
        '- [ ] check .github/workflows/deploy.yml run succeeded',
      ].join('\n');
      expect(isExclusivelyWorkflowScoped(body)).toBe(false);
    },
  );
});

describe('isCiTimeoutIssue — Mode 2 auto-file predicate (issue #4227)', () => {
  it('matches on the ci-timeout label alone', () => {
    expect(
      isCiTimeoutIssue({ title: 'CI Failure: Refresh thin-page promotions', body: '', labels: [{ name: 'ci-timeout' }] }),
    ).toBe(true);
  });

  it('matches on string-shaped labels too (gh --json labels sometimes flattens to names)', () => {
    expect(isCiTimeoutIssue({ title: 'x', body: '', labels: ['ci-timeout', 'bug'] })).toBe(true);
  });

  it('matches on the scan-job-timeouts.mjs signature string in the body, no label needed', () => {
    const body =
      '## Job cancellato per timeout\n\nRilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico).';
    expect(isCiTimeoutIssue({ title: 'CI Failure: X', body, labels: [] })).toBe(true);
  });

  it('does NOT match a follow-up issue with neither signal', () => {
    const body = '## Origine\nPR #4382\n\n### 1. Something deferred';
    expect(isCiTimeoutIssue({ title: 'follow-up(#4382): 1 item deferred', body, labels: [{ name: 'follow-up' }] })).toBe(
      false,
    );
  });

  it('handles missing/undefined fields without throwing', () => {
    expect(isCiTimeoutIssue({})).toBe(false);
    expect(isCiTimeoutIssue(undefined as unknown as Parameters<typeof isCiTimeoutIssue>[0])).toBe(false);
  });
});

describe('hasBlockedWorkflowsScopeMarker — FIX_OUTCOME marker detection', () => {
  it('detects the exact marker string', () => {
    expect(hasBlockedWorkflowsScopeMarker(['some text', '<!-- FIX_OUTCOME: blocked-workflows-scope -->'])).toBe(true);
  });

  it('detects the marker with extra internal whitespace (tolerant regex)', () => {
    expect(hasBlockedWorkflowsScopeMarker(['<!--   FIX_OUTCOME:   blocked-workflows-scope   -->'])).toBe(true);
  });

  it('detects the marker embedded mid-comment (not required to be alone on its line)', () => {
    expect(
      hasBlockedWorkflowsScopeMarker(['## Root cause\n...\n\n<!-- FIX_OUTCOME: blocked-workflows-scope -->\n']),
    ).toBe(true);
  });

  it('does NOT match a different FIX_OUTCOME code', () => {
    expect(hasBlockedWorkflowsScopeMarker(['<!-- FIX_OUTCOME: pr-created -->', '<!-- FIX_OUTCOME: max-turns -->'])).toBe(
      false,
    );
  });

  it('returns false for empty/undefined input', () => {
    expect(hasBlockedWorkflowsScopeMarker([])).toBe(false);
    expect(hasBlockedWorkflowsScopeMarker(undefined as unknown as string[])).toBe(false);
  });

  it('tolerates null/undefined entries in the array', () => {
    expect(hasBlockedWorkflowsScopeMarker([null, undefined, 'plain text'] as unknown as string[])).toBe(false);
  });
});

describe('filterExactTitleRecurrences — PROCEED-SAFE exact-match filter', () => {
  const title = 'CI Failure: Refresh thin-page promotions';

  it('keeps only candidates with the EXACT title, excludes near-title matches', () => {
    const candidates = [
      { number: 4375, title, createdAt: '2026-07-17T20:15:39Z' },
      { number: 4360, title: 'CI Failure: Refresh thin-page promotions (retry)', createdAt: '2026-07-17T10:00:00Z' },
      { number: 4322, title, createdAt: '2026-07-17T04:24:00Z' },
    ];
    const result = filterExactTitleRecurrences(candidates, title, 4389);
    expect(result.map((r) => r.number)).toEqual([4375, 4322]);
  });

  it('excludes the current issue number itself', () => {
    const candidates = [{ number: 4389, title, createdAt: '2026-07-18T11:25:13Z' }];
    expect(filterExactTitleRecurrences(candidates, title, 4389)).toHaveLength(0);
  });

  it('excludes the current issue number when passed as a string vs number mismatch', () => {
    const candidates = [{ number: 4389, title, createdAt: '2026-07-18T11:25:13Z' }];
    expect(filterExactTitleRecurrences(candidates, title, '4389')).toHaveLength(0);
  });

  it('sorts newest-first by createdAt', () => {
    const candidates = [
      { number: 4140, title, createdAt: '2026-07-13T08:28:51Z' },
      { number: 4375, title, createdAt: '2026-07-17T20:15:39Z' },
      { number: 4322, title, createdAt: '2026-07-17T04:24:00Z' },
    ];
    const result = filterExactTitleRecurrences(candidates, title, 9999);
    expect(result.map((r) => r.number)).toEqual([4375, 4322, 4140]);
  });

  it('caps the result at RECURRENCE_SCAN_CAP (10)', () => {
    const candidates = Array.from({ length: 15 }, (_, i) => ({
      number: 1000 + i,
      title,
      createdAt: new Date(2026, 6, i + 1).toISOString(),
    }));
    expect(filterExactTitleRecurrences(candidates, title, 9999)).toHaveLength(10);
  });

  it('returns empty array for empty/undefined candidates', () => {
    expect(filterExactTitleRecurrences([], title, 1)).toHaveLength(0);
    expect(filterExactTitleRecurrences(undefined as unknown as unknown[], title, 1)).toHaveLength(0);
  });
});
