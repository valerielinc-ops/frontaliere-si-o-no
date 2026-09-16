import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateNativeAutoMerge,
  latestBotReview,
  latestBotReviewOnHead,
  nativeAutoMergeArgs,
  isAlreadyInProgressOutput,
  parseActionsJobUrl,
  requiredVitestDecision,
  revalidateNativeAutoMerge,
  reviewGateEvidenceDecision,
  reviewHasLgtm,
  reviewIsApproved,
  reviewHasZeroFindings,
  isTransientGithubReadError,
  withTransientGithubReadRetry,
} from '../scripts/ci/native-automerge-gate.mjs';
import { TEST_REVIEW_MARKER } from '../scripts/ci/review-test-policy.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CLEAN_BODY = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';
const CODEX_FALLBACK_REVIEW = '<!-- CODEX_FALLBACK_REVIEW -->';

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

function testsOnlyReview(
  body = `${TEST_REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 2,
    user: { type: 'Bot', login: 'github-actions[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: HEAD,
    submitted_at: '2026-09-13T12:00:00Z',
    ...overrides,
  };
}

function reviewGateEvidenceFor(reviewId = '1', overrides: Record<string, any> = {}) {
  const check = vitest({
    id: 101,
    details_url: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/700/job/800',
    completed_at: '2026-09-13T12:05:00Z',
  });
  return {
    reviewId,
    check,
    workflow: {
      id: 700,
      path: '.github/workflows/tests.yml',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD,
      run_started_at: '2026-09-13T12:01:00Z',
      updated_at: '2026-09-13T12:06:00Z',
    },
    job: {
      id: 800,
      run_id: 700,
      name: 'vitest (unit + integration)',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD,
      started_at: '2026-09-13T12:01:10Z',
      completed_at: '2026-09-13T12:05:00Z',
      check_run_url: 'https://api.github.com/repos/valerielinc-ops/frontaliere-si-o-no/check-runs/101',
      steps: [
        {
          name: 'Require approving Claude review',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-09-13T12:03:00Z',
          completed_at: '2026-09-13T12:03:30Z',
        },
      ],
    },
    ...overrides,
  };
}

const OUTSIDE_FINDINGS_BODY = [
  '## Findings (Important: 2, Nit: 0)',
  '',
  '`scripts/legacy.mjs:L12`: 🔴 Important: old parser is unsafe.',
  '`scripts/other.mjs:L18`: 🔴 Important: other parser is unsafe.',
].join('\n');

function codexFallbackReview(
  body = `${CODEX_FALLBACK_REVIEW}\n${OUTSIDE_FINDINGS_BODY}`,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 3,
    user: { type: 'Bot', login: 'github-actions[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: HEAD,
    submitted_at: '2026-09-13T12:00:00Z',
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

  it('allows outside-diff findings only with the structured successful review-gate proof', () => {
    const rawReview = review(OUTSIDE_FINDINGS_BODY);
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [rawReview],
      checkRuns: [reviewGateEvidenceFor().check],
      reviewGateEvidence: reviewGateEvidenceFor(),
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    });

    expect(result.allow).toBe(true);
    expect(result.reason).toMatch(/outside-diff/i);
  });

  it('allows a marked github-actions Codex fallback only with structured review-gate proof', () => {
    const rawReview = codexFallbackReview();
    const evidence = reviewGateEvidenceFor(String(rawReview.id));
    expect(latestBotReview([rawReview])).toBeNull();
    expect(reviewIsApproved(rawReview)).toBe(false);
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [rawReview],
      checkRuns: [evidence.check],
      reviewGateEvidence: evidence,
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    });

    expect(result.allow).toBe(true);
    expect(result.reason).toMatch(/outside-diff/i);
  });

  it.each([
    ['exact fallback marker', OUTSIDE_FINDINGS_BODY, reviewGateEvidenceFor('3')],
    ['structured review-gate evidence', `${CODEX_FALLBACK_REVIEW}\n${OUTSIDE_FINDINGS_BODY}`, null],
  ])('rejects a Codex fallback without %s', (_label, body, evidence) => {
    const rawReview = codexFallbackReview(body);
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [rawReview],
      checkRuns: [evidence?.check || vitest()],
      reviewGateEvidence: evidence,
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    })).toMatchObject({ allow: false });
  });

  it('rejects a marked Codex fallback anchored to an older HEAD', () => {
    const staleReview = codexFallbackReview(undefined, { commit_id: OLD_HEAD });
    const evidence = reviewGateEvidenceFor(String(staleReview.id));

    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [staleReview],
      checkRuns: [evidence.check],
      reviewGateEvidence: evidence,
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    })).toMatchObject({ allow: false });
  });

  it('rejects an ordinary github-actions review even when structured proof is supplied', () => {
    const ordinaryReview = codexFallbackReview(CLEAN_BODY);
    const evidence = reviewGateEvidenceFor(String(ordinaryReview.id));

    expect(reviewGateEvidenceDecision({
      evidence,
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      head: HEAD,
      review: ordinaryReview,
    })).toMatchObject({ allow: false });
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [ordinaryReview],
      checkRuns: [evidence.check],
      reviewGateEvidence: evidence,
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    })).toMatchObject({ allow: false });
  });

  it('rejects an outside-diff-looking review without structured proof', () => {
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review(OUTSIDE_FINDINGS_BODY)],
      checkRuns: [reviewGateEvidenceFor().check],
    })).toMatchObject({ allow: false });
  });

  it('parses and binds the GitHub workflow run/job identity without live GitHub calls', () => {
    expect(parseActionsJobUrl(
      'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/700/job/800',
      'valerielinc-ops/frontaliere-si-o-no',
    )).toEqual({ runId: 700, jobId: 800 });
    expect(parseActionsJobUrl(
      'https://github.com/other/repo/actions/runs/700/job/800',
      'valerielinc-ops/frontaliere-si-o-no',
    )).toBeNull();
    expect(parseActionsJobUrl('not-a-github-url', 'valerielinc-ops/frontaliere-si-o-no')).toBeNull();
  });

  it.each([
    ['step assente', { job: { steps: [] } }],
    ['step fallito', { job: { steps: [{
        name: 'Require approving Claude review',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-09-13T12:03:00Z',
        completed_at: '2026-09-13T12:03:30Z',
      }] } }],
    ['run su HEAD diversa', { workflow: { head_sha: OLD_HEAD } }],
    ['step completato prima della review', { job: { steps: [{
      name: 'Require approving Claude review',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-09-13T11:59:00Z',
      completed_at: '2026-09-13T11:59:30Z',
    }] } }],
  ])('rifiuta la prova review-gate quando c’è %s', (_label, overrides) => {
    const rawReview = review(OUTSIDE_FINDINGS_BODY);
    expect(reviewGateEvidenceDecision({
      evidence: reviewGateEvidenceFor('1', overrides),
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      head: HEAD,
      review: rawReview,
    }).allow).toBe(false);
  });

  it('rejects a proof tied to an older review id after a newer raw bot review', () => {
    const newer = review(OUTSIDE_FINDINGS_BODY, HEAD, '2026-09-13T12:04:00Z', { id: 2 });
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review(OUTSIDE_FINDINGS_BODY), newer],
      checkRuns: [reviewGateEvidenceFor().check],
      reviewGateEvidence: reviewGateEvidenceFor(),
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    })).toMatchObject({ allow: false });
  });

  it('rejects a proof whose review identity or latest check identity is unverifiable', () => {
    const evidence = reviewGateEvidenceFor();
    const rawReview = review(OUTSIDE_FINDINGS_BODY);
    expect(reviewGateEvidenceDecision({
      evidence: { ...evidence, reviewId: '999' },
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      head: HEAD,
      review: rawReview,
    }).allow).toBe(false);

    const newerCheck = vitest({
      id: 102,
      details_url: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/701/job/801',
      completed_at: '2026-09-13T12:07:00Z',
    });
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [rawReview],
      checkRuns: [evidence.check, newerCheck],
      reviewGateEvidence: evidence,
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    })).toMatchObject({ allow: false });
  });

  it('rejects dismissed and non-reviewer states explicitly in the structured proof', () => {
    const evidence = reviewGateEvidenceFor();
    const rawReview = review(OUTSIDE_FINDINGS_BODY, HEAD, '2026-09-13T12:00:00Z', {
      state: 'DISMISSED',
    });
    expect(reviewGateEvidenceDecision({
      evidence,
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      head: HEAD,
      review: rawReview,
    }).allow).toBe(false);
    expect(reviewGateEvidenceDecision({
      evidence,
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      head: HEAD,
      review: { ...rawReview, state: 'CHANGES_REQUESTED' },
    }).allow).toBe(false);
  });

  it('fails closed when the opening event has no review', () => {
    expect(evaluateNativeAutoMerge({ pr: pr(), reviews: [], checkRuns: [vitest()] })).toMatchObject({
      allow: false,
    });
  });

  it('accepts tests-only approval only through the independently verified path', () => {
    const result = evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [],
      checkRuns: [vitest()],
      verifiedTestOnlyReview: testsOnlyReview(),
    });

    expect(result).toMatchObject({ allow: true, reviewId: 2 });
    expect(result.reason).toMatch(/tests-only review verificata/i);
  });

  it('does not turn a github-actions review into a general approval', () => {
    expect(reviewIsApproved(testsOnlyReview(TEST_REVIEW_MARKER + '\n## LGTM'))).toBe(false);
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [testsOnlyReview(TEST_REVIEW_MARKER + '\n## LGTM')],
      checkRuns: [vitest()],
    }).allow).toBe(false);
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

  it('keeps an in-scope Important finding blocked without an approving verdict', () => {
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [review('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: current diff breaks.')],
      checkRuns: [vitest()],
    })).toMatchObject({ allow: false });
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

  it('recognizes a concurrent GitHub auto-merge opt-in without treating other failures as benign', () => {
    expect(isAlreadyInProgressOutput('GraphQL: Merge already in progress (mergePullRequest)')).toBe(true);
    expect(isAlreadyInProgressOutput('GraphQL: Pull request is not mergeable')).toBe(false);
  });

  it('retries only transient GitHub read failures with a bounded schedule', () => {
    const transient = Object.assign(new Error('gh failed'), {
      stderr: 'HTTP 503: 503 Service Unavailable',
    });
    const permanent = Object.assign(new Error('gh failed'), {
      stderr: 'HTTP 403: 403 Forbidden',
    });
    const sleeps: number[] = [];
    let attempts = 0;

    const result = withTransientGithubReadRetry(() => {
      attempts += 1;
      if (attempts < 3) throw transient;
      return 'ok';
    }, { sleep: (delayMs) => sleeps.push(delayMs) });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 750]);
    expect(isTransientGithubReadError(transient)).toBe(true);
    expect(isTransientGithubReadError(permanent)).toBe(false);
  });

  it('keeps a permanent GitHub read failure fail-closed without retrying it', () => {
    const permanent = Object.assign(new Error('gh failed'), {
      stderr: 'HTTP 403: 403 Forbidden',
    });
    let attempts = 0;

    expect(() => withTransientGithubReadRetry(() => {
      attempts += 1;
      throw permanent;
    }, { sleep: () => undefined })).toThrow('gh failed');
    expect(attempts).toBe(1);
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
    expect(gateSource).toContain('concurrentOptInSucceeded');
    expect(gateSource).toContain('function ghJson(args)');
    expect(gateSource).toContain('function ghJsonOnce(args)');
    expect(gateSource).toContain('withTransientGithubReadRetry');
    expect(gateSource).toContain('const response = ghJsonOnce');
    expect(gateSource).toContain("stdio: ['ignore', 'pipe', 'pipe']");
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
    expect(workflow).toContain('scripts/ci/review-test-policy.mjs?ref=main');
    expect(workflow).toContain('scripts/ci/lib/fetchPrFiles.mjs?ref=main');
    expect(workflow).toContain('scripts/ci/lib/vitestCheck.mjs?ref=main');
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
    expect(retry).toContain('scripts/ci/review-test-policy.mjs?ref=main');
    expect(retry).toContain('scripts/ci/lib/fetchPrFiles.mjs?ref=main');
    expect(retry).toContain('scripts/ci/lib/vitestCheck.mjs?ref=main');
    expect(retry).toContain('node --check "$gate_tmp"');
    expect(retry).not.toContain('native-automerge-gate.mjs.tmp');
    expect(retry).not.toContain('.[:$max][]');
    expect(retry).not.toContain("jq -e '.autoMergeRequest != null'");
    expect(retry).not.toContain('gh pr merge');
  });
});
