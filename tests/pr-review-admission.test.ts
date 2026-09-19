import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  admissionCli,
  boundReviewsToFirstHeadVerdict,
  firstTerminalBotReviewOnHead,
  parseReviewPages,
  reviewBodyIsApproving,
  reviewHasLgtm,
  reviewHasZeroFindings,
  shouldRunRedflagFixer,
  shouldSkipModelReview,
} from '../scripts/ci/lib/pr-review-admission.mjs';
import {
  evaluateNativeAutoMerge,
  revalidateNativeAutoMerge,
  reviewIsApproved,
} from '../scripts/ci/native-automerge-gate.mjs';
import { runReviewGate } from '../scripts/ci/review-gate.mjs';
import { reviewInputRevisionFromBody } from '../scripts/ci/lib/review-input-revision.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const PR_BODY = '## Implementato\n- skip\n\n## Non implementato (ancora)\n- corpus twins, in questa PR, per scelta. **Motivo:** adapted. **Prossimo passo:** nessuno.';
const REVIEW_REVISION = reviewInputRevisionFromBody(PR_BODY);
const OLD_REVIEW_REVISION = `body:${'d'.repeat(64)}`;
const REVIEW_MARKER = `<!-- REVIEW_INPUT_REVISION: ${REVIEW_REVISION} -->`;
const OLD_REVIEW_MARKER = `<!-- REVIEW_INPUT_REVISION: ${OLD_REVIEW_REVISION} -->`;
const CLEAN = `${REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`;
const LGTM_WITHOUT_FINDINGS = `${REVIEW_MARKER}\n## Scope\nReviewed the delta.\n\n## LGTM`;
const IMPORTANT = `${REVIEW_MARKER}\n## Findings (Important: 1, Nit: 0)\n\n\`scripts/lib/foo.mjs:L12\`: 🔴 Important: pagination is incomplete.\n`;

function botReview(body: string, commit_id = HEAD, submitted_at = '2026-09-18T01:00:00Z', overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED',
    body,
    commit_id,
    submitted_at,
    ...overrides,
  };
}

function vitest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'vitest (unit + integration)',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-09-18T01:01:00Z',
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    title: 'fix(ci): stabilize PR review loop',
    body: PR_BODY,
    labels: [],
    headRefOid: HEAD,
    autoMergeRequest: null,
    changedFiles: ['scripts/ci/lib/pr-review-admission.mjs'],
    changedFilesComplete: true,
    ...overrides,
  };
}

function runCli(mode: string, args: string[], reviews: unknown) {
  const result = spawnSync(process.execPath, [
    'scripts/ci/lib/pr-review-admission.mjs',
    mode,
    ...args,
  ], {
    input: JSON.stringify(reviews),
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  return result;
}

describe('9066/9074 review-loop admission', () => {
  it('skips a second model review on the same HEAD even when the event is edited', () => {
    const lgtm = botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 });
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [lgtm],
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [lgtm],
      eventAction: 'synchronize',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [lgtm],
      eventAction: 'opened',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
  });

  it('does not skip when the only terminal review names an older SHA', () => {
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [botReview(CLEAN, OLD_HEAD)],
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(false);
  });

  it('ignores historical non-terminal review states without treating them as current input', () => {
    const current = botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 30 });
    const pending = botReview(CLEAN, HEAD, '2026-09-18T05:00:00Z', { id: 31, state: 'PENDING' });
    const dismissed = botReview(CLEAN, HEAD, '2026-09-18T06:00:00Z', { id: 32, state: 'DISMISSED' });
    expect(firstTerminalBotReviewOnHead([pending, dismissed, current], HEAD, { reviewRevision: REVIEW_REVISION })?.id)
      .toBe(30);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [pending, dismissed, current],
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
  });

  it('re-arms one complete review when the body revision changes on the same HEAD', () => {
    const oldBodyReview = botReview(
      `${OLD_REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
      HEAD,
      '2026-09-18T04:04:10Z',
      { id: 28 },
    );
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [oldBodyReview],
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(false);
  });

  it('deduplicates duplicate body-edit deliveries for the current revision', () => {
    const current = botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 29 });
    const duplicate = { ...current };
    const reviews = [current, duplicate];
    expect(firstTerminalBotReviewOnHead(reviews, HEAD, { reviewRevision: REVIEW_REVISION })?.id).toBe(29);
    expect(boundReviewsToFirstHeadVerdict(reviews, HEAD, { reviewRevision: REVIEW_REVISION })).toHaveLength(1);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews,
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
  });

  it('treats ## LGTM without a Findings heading as approving when there is no 🔴 Important', () => {
    expect(reviewHasLgtm(LGTM_WITHOUT_FINDINGS)).toBe(true);
    expect(reviewHasZeroFindings(LGTM_WITHOUT_FINDINGS)).toBe(true);
    expect(reviewBodyIsApproving(LGTM_WITHOUT_FINDINGS)).toBe(true);
    expect(reviewIsApproved(botReview(LGTM_WITHOUT_FINDINGS))).toBe(true);
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [botReview(LGTM_WITHOUT_FINDINGS)],
      checkRuns: [vitest()],
    })).toMatchObject({ allow: true });
  });

  it('keeps a current-HEAD 🔴 Important from opting into native auto-merge', () => {
    const important = botReview(IMPORTANT);
    expect(reviewBodyIsApproving(IMPORTANT)).toBe(false);
    expect(reviewIsApproved(important)).toBe(false);
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews: [important],
      checkRuns: [vitest()],
    })).toMatchObject({ allow: false });
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [important],
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
  });

  it('does not let a later same-HEAD Important revoke a current-HEAD LGTM', () => {
    const reviews = [
      botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 }),
      botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 }),
    ];
    expect(firstTerminalBotReviewOnHead(reviews, HEAD)?.id).toBe(27);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews,
      eventAction: 'edited',
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
    expect(evaluateNativeAutoMerge({
      pr: pr(),
      reviews,
      checkRuns: [vitest()],
    })).toMatchObject({ allow: true });
    expect(revalidateNativeAutoMerge({
      pr: pr({ autoMergeRequest: { enabledAt: '2026-09-18T04:05:00Z' } }),
      reviews,
      checkRuns: [vitest()],
    })).toMatchObject({ allow: true, action: 'retain' });
  });

  it('runs the 🔴 fixer only for the first terminal Important on the current HEAD', () => {
    const first = botReview(IMPORTANT, HEAD, '2026-09-18T03:42:58Z', { id: 26 });
    const second = botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 });
    expect(shouldRunRedflagFixer({
      reviews: [first],
      headSha: HEAD,
      reviewId: 26,
      reviewCommit: HEAD,
      reviewRevision: REVIEW_REVISION,
    })).toBe(true);
    expect(shouldRunRedflagFixer({
      reviews: [botReview(`${OLD_REVIEW_MARKER}\n## Findings (Important: 1, Nit: 0)\n\n🔴 Important: old body revision.`, HEAD, '2026-09-18T03:42:58Z', { id: 25 })],
      headSha: HEAD,
      reviewId: 25,
      reviewCommit: HEAD,
      reviewRevision: REVIEW_REVISION,
    })).toBe(false);
    expect(shouldRunRedflagFixer({
      reviews: [first, second],
      headSha: HEAD,
      reviewId: 28,
      reviewCommit: HEAD,
    })).toBe(false);
    expect(shouldRunRedflagFixer({
      reviews: [botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 }), second],
      headSha: HEAD,
      reviewId: 28,
      reviewCommit: HEAD,
    })).toBe(false);
    expect(shouldRunRedflagFixer({
      reviews: [first],
      headSha: HEAD,
      reviewId: 26,
      reviewCommit: OLD_HEAD,
    })).toBe(false);
  });

  it('drives the shipped skip CLI used by tests.yml', () => {
    const reviews = [botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 })];
    const skipped = runCli('skip', ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION], reviews);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout.trim()).toBe('skip=true');
    expect(skipped.stderr).toMatch(/nessuna seconda review, anche dopo un evento edited/i);

    const fresh = runCli('skip', ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION], []);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout.trim()).toBe('skip=false');
  });

  it('fails closed when the review input revision is missing or the reviews API is malformed', () => {
    const missingRevision = runCli('skip', ['--head', HEAD, '--event', 'edited'], [botReview(CLEAN)]);
    expect(missingRevision.status).toBe(1);
    expect(missingRevision.stdout.trim()).toBe('skip=false');
    const malformed = runCli('skip', ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION], '{');
    expect(malformed.status).toBe(1);
    expect(malformed.stdout.trim()).toBe('skip=false');
    for (const malformedPage of [[null], [[null]], [{ id: 1 }]]) {
      const result = runCli(
        'skip',
        ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION],
        malformedPage,
      );
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('skip=false');
    }
  });

  it('accepts only complete flat entries or one-level paginated review pages', () => {
    const review = botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 });
    const flat = runCli('skip', ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION], [review]);
    const pages = runCli('skip', ['--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION], [[review]]);
    expect(flat.status).toBe(0);
    expect(flat.stdout.trim()).toBe('skip=true');
    expect(pages.status).toBe(0);
    expect(pages.stdout.trim()).toBe('skip=true');
  });

  it('shares strict validation for decoded API pages used by the native/review gates', () => {
    const review = botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 });
    expect(parseReviewPages([[review]])).toEqual([review]);
    expect(parseReviewPages([review])).toEqual([review]);
    expect(parseReviewPages([[{ ...review, state: undefined }]])).toBeNull();
    expect(parseReviewPages([[{ ...review, user: { type: 'Bot' } }]])).toBeNull();
    expect(parseReviewPages('not-json')).toBeNull();
  });

  it('drives the shipped fixer CLI used by pr-redflag-fixer.yml', () => {
    const first = botReview(IMPORTANT, HEAD, '2026-09-18T03:42:58Z', { id: 26 });
    const second = botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 });
    const allowed = runCli('fixer', ['--head', HEAD, '--review-id', '26', '--review-commit', HEAD, '--revision', REVIEW_REVISION], [first]);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout.trim()).toBe('actionable=true');

    const denied = runCli('fixer', ['--head', HEAD, '--review-id', '28', '--review-commit', HEAD, '--revision', REVIEW_REVISION], [first, second]);
    expect(denied.status).toBe(0);
    expect(denied.stdout.trim()).toBe('actionable=false');

    const unavailable = runCli('fixer', ['--head', HEAD, '--review-id', '26', '--review-commit', HEAD, '--revision', REVIEW_REVISION], '{');
    expect(unavailable.status).toBe(1);
    expect(unavailable.stdout.trim()).toBe('actionable=false');
  });

  it('keeps stdout as the GitHub output line when admissionCli is called in-process', () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const status = admissionCli(
        ['node', 'pr-review-admission.mjs', 'skip', '--head', HEAD, '--event', 'edited', '--revision', REVIEW_REVISION],
        JSON.stringify([botReview(CLEAN)]),
      );
      expect(status).toBe(0);
      expect(chunks.join('')).toBe('skip=true\n');
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

describe('review gate uses the first HEAD verdict', () => {
  it('does not let a later same-HEAD Important fail a current-HEAD LGTM', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD,
      reviews: [[
        botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 }),
        botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 }),
      ]],
      mutate: false,
    });
    expect(result.approved).toBe(true);
    expect(boundReviewsToFirstHeadVerdict([
      botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 }),
      botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 }),
    ], HEAD)).toHaveLength(1);
  });

  it('still blocks when the first terminal review on HEAD is Important', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD,
      reviews: [[botReview(IMPORTANT, HEAD, '2026-09-18T03:42:58Z', { id: 26 })]],
      mutate: false,
      classifyAndMintReviewFn: async () => ({
        findings: [{ text: IMPORTANT }],
        outside: [],
        inScope: [{ text: IMPORTANT }],
        unresolved: [],
        outsideOnly: false,
        blocking: true,
      }),
    });
    expect(result.approved).toBe(false);
  });
});

describe('workflow wiring for one review per HEAD', () => {
  const testsYml = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
  const fixerYml = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');
  const bodyRecoveryYml = readFileSync(new URL('../.github/workflows/retry-code-check-after-body-edit.yml', import.meta.url), 'utf8');
  const tests = YAML.parse(testsYml);

  it('tests.yml skip guard calls the shipped helper and does not re-review on edited', () => {
    const guard = tests.jobs.vitest.steps.find((step: { id?: string }) => step.id === 'guard');
    expect(guard?.run).toContain('node "$REVIEW_POLICY_ROOT/scripts/ci/lib/pr-review-admission.mjs" skip');
    expect(guard?.run).toContain('gh api "repos/$REPO/pulls/$PR_NUMBER/reviews"');
    expect(guard?.run).toContain('--revision "$REVIEW_REVISION"');
    const input = tests.jobs.vitest.steps.find((step: { id?: string }) => step.id === 'review_input');
    expect(input?.run).toContain('review-input-revision.mjs" hash-pr-json');
    expect(testsYml).toContain('REVIEW_INPUT_REVISION: ${{ steps.review_input.outputs.review_revision }}');
    expect(guard?.run).not.toContain('PR metadata modificata → review piena');
    expect(guard?.env?.EVENT_ACTION).toBeUndefined();
    const gate = tests.jobs.vitest.steps.find((step: { id?: string }) => step.id === 'review_gate');
    expect(gate?.if).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(gate?.if).not.toContain("steps.guard.outputs.skip != 'true'");
    expect(testsYml).toContain("steps.review_gate.outcome == 'skipped'");
    expect(testsYml).not.toMatch(/steps\.guard\.outputs\.skip != 'true' && steps\.review_gate\.outcome == 'skipped'/);
  });

  it('pr-redflag-fixer admits only the first terminal Important and forbids empty commits', () => {
    expect(fixerYml).toContain('node "$TRUSTED_POLICY_ROOT/scripts/ci/lib/pr-review-admission.mjs" fixer');
    expect(fixerYml).toContain('node "$TRUSTED_POLICY_ROOT/scripts/ci/lib/review-input-revision.mjs" hash-pr-json');
    expect(fixerYml).toContain('Bootstrap trusted fixer policy (no PR code)');
    expect(fixerYml).toContain('Refresh trusted fixer policy before claim');
    expect(fixerYml).toContain('Refresh trusted fixer policy after model');
    expect(fixerYml).toContain('TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_post_model.outputs.root }}');
    expect(fixerYml).toContain('--revision "$review_revision"');
    expect(fixerYml).toMatch(/Reviews API illeggibile.*nessun Codex/s);
    expect(fixerYml).toContain('Admit only the first terminal');
    expect(fixerYml).not.toMatch(/git commit --allow-empty/);
    expect(fixerYml).toMatch(/Niente commit vuoto|non pushare un commit vuoto/i);
  });

  it('keeps title-only edits out while body edits revalidate the trusted review input', () => {
    expect(testsYml).toMatch(/types:\s*\[opened, synchronize, reopened, ready_for_review\]/);
    expect(bodyRecoveryYml).toContain('types: [edited]');
    expect(bodyRecoveryYml).toContain("github.event_name == 'workflow_run' || github.event_name == 'schedule' || github.event.changes.body != null");
    expect(bodyRecoveryYml).toContain('workflows: [tests]');
    expect(bodyRecoveryYml).toContain('BODY_REVIEW_RECOVERY_PENDING');
    expect(bodyRecoveryYml).not.toContain('setTimeout');
    expect(bodyRecoveryYml).toContain('the PR body changed; revalidate the review input revision');
    expect(bodyRecoveryYml).toContain('tests.yml');
  });
});
