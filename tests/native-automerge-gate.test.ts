import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateNativeAutoMerge,
  latestBotReviewOnHead,
  nativeAutoMergeArgs,
  requiredVitestDecision,
  revalidateNativeAutoMerge,
  reviewHasLgtm,
  reviewHasZeroFindings,
} from '../scripts/ci/native-automerge-gate.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CLEAN_BODY = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';

function review(body: string, commit_id = HEAD, submitted_at = '2026-09-13T12:00:00Z') {
  return {
    id: 1,
    user: { type: 'Bot', login: 'claude[bot]' },
    state: 'COMMENTED',
    body,
    commit_id,
    submitted_at,
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
  it('allows only the exact-head bot verdict plus a completed green Vitest check', () => {
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

  it('rejects a clean review anchored to a stale HEAD', () => {
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review(CLEAN_BODY, OLD_HEAD)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: false });
    expect(result.reason).toMatch(/exact-head/i);
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

  it('requires explicit Important 0, Nit 0 and an H2 LGTM', () => {
    expect(reviewHasZeroFindings(CLEAN_BODY)).toBe(true);
    expect(reviewHasLgtm(CLEAN_BODY)).toBe(true);
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

  it('marks a persisted native opt-in for revocation when the current HEAD lacks a fresh verdict', () => {
    const result = revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [review(CLEAN_BODY, OLD_HEAD)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: false, action: 'revoke' });
    expect(result.reason).toMatch(/exact-head/i);
  });

  it('retains a persisted native opt-in only after revalidating the current HEAD', () => {
    const result = revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-13T12:00:00Z' } }),
      reviews: [review(CLEAN_BODY)],
      checkRuns: [vitest()],
    });

    expect(result).toMatchObject({ allow: true, action: 'retain' });
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
});

describe('native auto-merge workflow wiring (#8512)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url), 'utf8');
  const retry = readFileSync(new URL('../.github/workflows/retry-native-automerge.yml', import.meta.url), 'utf8');

  it('evaluates review and workflow-run events, while opening remains a guarded observation', () => {
    expect(workflow).toContain('types: [opened, reopened, ready_for_review, synchronize]');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain('types: [submitted]');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [tests]');
    expect(workflow).toContain('NATIVE_AUTOMERGE_BOOTSTRAP_READY=false');
    expect(workflow).toContain('node --check "$gate_tmp"');
    expect(workflow).toContain("if: env.NATIVE_AUTOMERGE_BOOTSTRAP_READY == 'true'");
    expect(workflow).toContain('native-automerge-gate.mjs');
    expect(workflow).not.toContain('gh pr merge "$PR_NUMBER"');
  });

  it('routes the scheduled retry through the same guard and never bypasses it', () => {
    expect(retry).toContain('native-automerge-gate.mjs');
    expect(retry).toContain('MAX_PR_SCAN: \'100\'');
    expect(retry).toContain('sort_by(.createdAt) | reverse | .[].number');
    expect(retry).not.toContain('.[:$max][]');
    expect(retry).not.toContain("jq -e '.autoMergeRequest != null'");
    expect(retry).not.toContain('gh pr merge');
  });
});
