import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  admissionCli,
  boundReviewsToFirstHeadVerdict,
  firstTerminalBotReviewOnHead,
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

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CLEAN = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';
const LGTM_WITHOUT_FINDINGS = '## Scope\nReviewed the delta.\n\n## LGTM';
const IMPORTANT = '## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/foo.mjs:L12`: 🔴 Important: pagination is incomplete.\n';

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
    body: '## Implementato\n- skip\n\n## Non implementato (ancora)\n- corpus twins, in questa PR, per scelta. **Motivo:** adapted. **Prossimo passo:** nessuno.',
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
    })).toBe(true);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [lgtm],
      eventAction: 'synchronize',
    })).toBe(true);
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [lgtm],
      eventAction: 'opened',
    })).toBe(true);
  });

  it('does not skip when the only terminal review names an older SHA', () => {
    expect(shouldSkipModelReview({
      headSha: HEAD,
      reviews: [botReview(CLEAN, OLD_HEAD)],
      eventAction: 'edited',
    })).toBe(false);
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
    expect(shouldSkipModelReview({ headSha: HEAD, reviews: [important], eventAction: 'edited' })).toBe(true);
  });

  it('does not let a later same-HEAD Important revoke a current-HEAD LGTM', () => {
    const reviews = [
      botReview(CLEAN, HEAD, '2026-09-18T04:04:10Z', { id: 27 }),
      botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 }),
    ];
    expect(firstTerminalBotReviewOnHead(reviews, HEAD)?.id).toBe(27);
    expect(shouldSkipModelReview({ headSha: HEAD, reviews, eventAction: 'edited' })).toBe(true);
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
    })).toBe(true);
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
    const skipped = runCli('skip', ['--head', HEAD, '--event', 'edited'], reviews);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout.trim()).toBe('skip=true');
    expect(skipped.stderr).toMatch(/nessuna seconda review, anche dopo un evento edited/i);

    const fresh = runCli('skip', ['--head', HEAD, '--event', 'edited'], []);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout.trim()).toBe('skip=false');
  });

  it('drives the shipped fixer CLI used by pr-redflag-fixer.yml', () => {
    const first = botReview(IMPORTANT, HEAD, '2026-09-18T03:42:58Z', { id: 26 });
    const second = botReview(IMPORTANT, HEAD, '2026-09-18T04:40:15Z', { id: 28 });
    const allowed = runCli('fixer', ['--head', HEAD, '--review-id', '26', '--review-commit', HEAD], [first]);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout.trim()).toBe('actionable=true');

    const denied = runCli('fixer', ['--head', HEAD, '--review-id', '28', '--review-commit', HEAD], [first, second]);
    expect(denied.status).toBe(0);
    expect(denied.stdout.trim()).toBe('actionable=false');
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
        ['node', 'pr-review-admission.mjs', 'skip', '--head', HEAD, '--event', 'edited'],
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
  const tests = YAML.parse(testsYml);

  it('tests.yml skip guard calls the shipped helper and does not re-review on edited', () => {
    const guard = tests.jobs.vitest.steps.find((step: { id?: string }) => step.id === 'guard');
    expect(guard?.run).toContain('node scripts/ci/lib/pr-review-admission.mjs skip');
    expect(guard?.run).toContain('gh api "repos/$REPO/pulls/$PR_NUMBER/reviews"');
    expect(guard?.run).not.toContain('PR metadata modificata → review piena');
    expect(guard?.env?.EVENT_ACTION).toBeUndefined();
    const gate = tests.jobs.vitest.steps.find((step: { id?: string }) => step.id === 'review_gate');
    expect(gate?.if).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(gate?.if).not.toContain("steps.guard.outputs.skip != 'true'");
    expect(testsYml).toContain("steps.review_gate.outcome == 'skipped'");
    expect(testsYml).not.toMatch(/steps\.guard\.outputs\.skip != 'true' && steps\.review_gate\.outcome == 'skipped'/);
  });

  it('pr-redflag-fixer admits only the first terminal Important and forbids empty commits', () => {
    expect(fixerYml).toContain('node scripts/ci/lib/pr-review-admission.mjs fixer');
    expect(fixerYml).toContain('Admit only the first terminal');
    expect(fixerYml).not.toMatch(/git commit --allow-empty/);
    expect(fixerYml).toMatch(/Niente commit vuoto|non pushare un commit vuoto/i);
  });
});
