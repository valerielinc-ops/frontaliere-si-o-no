import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateNativeAutoMerge,
  latestBotReview,
  latestBotReviewOnHead,
  nativeAutoMergeArgs,
  requiredVitestDecision,
  revalidateNativeAutoMerge,
  reviewHasLgtm,
  reviewIsApproved,
  reviewHasZeroFindings,
} from '../scripts/ci/native-automerge-gate.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CLEAN_BODY = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';

function review(
  body: string,
  commit_id = HEAD,
  submitted_at = '2026-09-13T12:00:00Z',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 1,
    user: { type: 'Bot', login: 'claude[bot]' },
    state: 'COMMENTED',
    body,
    commit_id,
    submitted_at,
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefOid: HEAD,
    autoMergeRequest: null,
    ...overrides,
  };
}

function vitest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'vitest (unit + integration)',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-09-13T12:01:00Z',
    ...overrides,
  };
}

describe('native auto-merge gate (#8512)', () => {
  it('allows an approving bot verdict plus a completed green current-head check', () => {
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review(CLEAN_BODY)],
      checkRuns: [vitest()],
    });

    expect(result.allow).toBe(true);
    expect(result.reason).toContain('success');
  });

  it('fails closed when the opening event has no review', () => {
    expect(evaluateNativeAutoMerge({ pr: pr(), reviews: [], checkRuns: [vitest()] })).toMatchObject({
      allow: false,
    });
  });

  it('carries a clean older LGTM forward when the complete current-head check is green', () => {
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review(CLEAN_BODY, OLD_HEAD)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: true });
    expect(result.reason).toMatch(/carry-forward/i);
  });

  it('uses the latest bot review across commits and blocks a later stale finding', () => {
    const reviews = [
      review(CLEAN_BODY, HEAD, '2026-09-13T12:00:00Z'),
      review(
        '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: stale finding.\n\n## LGTM',
        OLD_HEAD,
        '2026-09-13T12:02:00Z',
      ),
    ];

    expect(latestBotReview(reviews)?.commit_id).toBe(OLD_HEAD);
    expect(evaluateNativeAutoMerge({ pr: pr(), reviews, checkRuns: [vitest()] })).toMatchObject({
      allow: false,
    });
  });

  it('uses the newest bot review on the current HEAD, so a later finding wins', () => {
    const reviews = [
      review(CLEAN_BODY, HEAD, '2026-09-13T12:00:00Z'),
      review(
        '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: guard bypass.\n\n## LGTM',
        HEAD,
        '2026-09-13T12:02:00Z',
      ),
    ];

    expect(latestBotReviewOnHead(reviews, HEAD)?.body).toContain('Important: 1');
    expect(evaluateNativeAutoMerge({ pr: pr(), reviews, checkRuns: [vitest()] }).allow).toBe(false);
  });

  it('orders an edited older review after a newer submitted verdict', () => {
    const reviews = [
      review(
        '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: edit regression.\n\n## LGTM',
        HEAD,
        '2026-09-13T12:00:00Z',
        { id: 1, updated_at: '2026-09-13T12:04:00Z' },
      ),
      review(CLEAN_BODY, HEAD, '2026-09-13T12:03:00Z', { id: 2 }),
    ];

    expect(latestBotReviewOnHead(reviews, HEAD)?.body).toContain('Important: 1');
    expect(evaluateNativeAutoMerge({ pr: pr(), reviews, checkRuns: [vitest()] }).allow).toBe(false);
  });

  it('requires explicit Important 0, Nit 0 and an H2 LGTM', () => {
    expect(reviewHasZeroFindings(CLEAN_BODY)).toBe(true);
    expect(reviewHasLgtm(CLEAN_BODY)).toBe(true);
    expect(reviewIsApproved(review(CLEAN_BODY))).toBe(true);
    expect(reviewHasZeroFindings('## Findings (Important: 0, Nit: 1)\n\n## LGTM')).toBe(false);
    expect(reviewHasZeroFindings('## Findings (Important: 0, Nit: 0)\n\n🟡 Nit: not harmless')).toBe(false);
    expect(reviewHasLgtm('The text says ## LGTM, but is not a heading')).toBe(false);
  });

  it.each([
    ['missing', []],
    ['pending', [vitest({ status: 'in_progress', conclusion: null, completed_at: null })]],
    ['failure', [vitest({ conclusion: 'failure' })]],
    ['wrong HEAD', [vitest({ head_sha: OLD_HEAD })]],
  ])('does not accept a %s required check', (_label, checkRuns) => {
    expect(requiredVitestDecision(checkRuns, HEAD).allow).toBe(false);
  });

  it('does not re-enable an already native-merged PR', () => {
    expect(evaluateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [],
      checkRuns: [],
    })).toMatchObject({ allow: false, reason: 'native auto-merge già abilitato' });
  });

  it('marks a persisted native opt-in for revocation when the latest verdict is not approving', () => {
    const result = revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [review('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: regression.', OLD_HEAD)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: false, action: 'revoke' });
    expect(result.reason).toMatch(/Important 0\/Nit 0/i);
  });

  it('retains a persisted native opt-in only after revalidating the current HEAD', () => {
    const result = revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [review(CLEAN_BODY)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: true, action: 'retain' });
  });

  it('retains a persisted native opt-in when the full current-head check validates LGTM carry-forward', () => {
    const result = revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [review(CLEAN_BODY, OLD_HEAD)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: true, action: 'retain' });
    expect(result.reason).toMatch(/carry-forward/i);
  });

  it('revokes an inherited native opt-in through the GitHub API instead of trusting persistence', () => {
    const gateSource = readFileSync(new URL('../scripts/ci/native-automerge-gate.mjs', import.meta.url), 'utf8');

    expect(gateSource).toContain('disablePullRequestAutoMerge');
    expect(gateSource).toContain('revokeExistingAutoMerge');
    expect(gateSource).not.toContain('if (pr.autoMergeRequest !== null) return skip');
  });

  it('binds the native opt-in to the exact HEAD that passed the gate', () => {
    const gateSource = readFileSync(new URL('../scripts/ci/native-automerge-gate.mjs', import.meta.url), 'utf8');

    expect(gateSource).toContain("nativeAutoMergeArgs({ repo, prNumber, headSha: pr.headRefOid })");
    expect(nativeAutoMergeArgs({
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      prNumber: '8517',
      headSha: HEAD,
    })).toEqual([
      'pr', 'merge', '8517', '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      '--auto', '--squash', '--delete-branch', '--match-head-commit', HEAD,
    ]);
    expect(() => nativeAutoMergeArgs({
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      prNumber: '8517',
      headSha: 'not-a-sha',
    })).toThrow(/HEAD SHA/);
  });

  it('revalidates review and checks after the final HEAD read and before native opt-in', () => {
    const gateSource = readFileSync(new URL('../scripts/ci/native-automerge-gate.mjs', import.meta.url), 'utf8');
    const headRead = gateSource.indexOf('current = ghJson');
    const finalReviewRead = gateSource.indexOf('finalReviews = loadReviews');
    const finalCheckRead = gateSource.indexOf('finalCheckRuns = loadCheckRuns');
    const finalGate = gateSource.indexOf('const finalDecision = revalidateNativeAutoMerge');
    const nativeOptIn = gateSource.indexOf("execFileSync('gh', nativeAutoMergeArgs");

    expect(headRead).toBeGreaterThanOrEqual(0);
    expect(finalReviewRead).toBeGreaterThan(headRead);
    expect(finalCheckRead).toBeGreaterThan(finalReviewRead);
    expect(finalGate).toBeGreaterThan(finalCheckRead);
    expect(nativeOptIn).toBeGreaterThan(finalGate);
    expect(gateSource).toContain("if (finalDecision.action === 'revoke')");
  });

  it('fails closed when the final same-HEAD snapshot gains a finding or check failure', () => {
    const initial = revalidateNativeAutoMerge({
      pr: pr(),
      reviews: [review(CLEAN_BODY)],
      checkRuns: [vitest()],
    });
    expect(initial).toMatchObject({ allow: true, action: 'enable' });

    const final = revalidateNativeAutoMerge({
      pr: pr(),
      reviews: [
        review(CLEAN_BODY, HEAD, '2026-09-13T12:00:00Z'),
        review(
          '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: stale gate.\n\n## LGTM',
          HEAD,
          '2026-09-13T12:02:00Z',
        ),
      ],
      checkRuns: [vitest({ conclusion: 'failure' })],
    });
    expect(final).toMatchObject({ allow: false, action: 'skip' });
  });
});

describe('native auto-merge workflow wiring (#8512)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url), 'utf8');
  const retry = readFileSync(new URL('../.github/workflows/retry-native-automerge.yml', import.meta.url), 'utf8');

  it('evaluates review and workflow-run events, while opening remains a guarded observation', () => {
    expect(workflow).toContain('types: [opened, reopened, ready_for_review, synchronize]');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain('types: [submitted, edited, dismissed]');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [tests]');
    expect(workflow).toContain('NATIVE_AUTOMERGE_BOOTSTRAP_READY=false');
    expect(workflow).toContain('gate_tmp="$helper_dir/native-automerge-gate-check.mjs"');
    expect(workflow).toContain('node --check "$gate_tmp"');
    expect(workflow).not.toContain('native-automerge-gate.mjs.tmp');
    expect(workflow).toContain("if: env.NATIVE_AUTOMERGE_BOOTSTRAP_READY == 'true'");
    expect(workflow).toContain('native-automerge-gate.mjs');
    expect(workflow).not.toContain('gh pr merge "$PR_NUMBER"');
  });

  it('routes the scheduled retry through the same guard and never bypasses it', () => {
    expect(retry).toContain('native-automerge-gate.mjs');
    expect(retry).toContain('MAX_PR_SCAN: \'100\'');
    expect(retry).toContain('sort_by(.createdAt) | reverse | .[].number');
    expect(retry).toContain('gate_tmp="$helper_dir/native-automerge-gate-check.mjs"');
    expect(retry).toContain('node --check "$gate_tmp"');
    expect(retry).not.toContain('native-automerge-gate.mjs.tmp');
    expect(retry).not.toContain('.[:$max][]');
    expect(retry).not.toContain("jq -e '.autoMergeRequest != null'");
    expect(retry).not.toContain('gh pr merge');
  });
});
