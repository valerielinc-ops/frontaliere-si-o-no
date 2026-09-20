import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const workflowJobs = (YAML.parse(workflow) as { jobs?: Record<string, { if?: string }> }).jobs ?? {};
const reviewGate = readFileSync(new URL('../scripts/ci/review-gate.mjs', import.meta.url), 'utf8');
const staleRescuer = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');
const autorebase = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const autoMergeEval = readFileSync(new URL('../scripts/ci/auto-merge-eval.mjs', import.meta.url), 'utf8');
const nativeAutoMerge = readFileSync(new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url), 'utf8');
const nativeAutoMergeRetry = readFileSync(new URL('../.github/workflows/retry-native-automerge.yml', import.meta.url), 'utf8');
const redflagFixer = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');
const translatePendingLogic = readFileSync(new URL('../.github/workflows/translate-pending-logic.yml', import.meta.url), 'utf8');

describe('review → autorebase ordering', () => {
  it('keeps delegated daily housekeeping fail-closed before committing', () => {
    const housekeepingStart = translatePendingLogic.indexOf('name: "Phase 1: Housekeeping"');
    const commitStart = translatePendingLogic.indexOf('name: Commit housekeeping');
    const housekeepingBlock = translatePendingLogic.slice(housekeepingStart, commitStart);
    const commitBlock = translatePendingLogic.slice(commitStart, translatePendingLogic.indexOf('\n      - name:', commitStart + 1));
    const commitIf = commitBlock.split('\n').find((line) => /^\s+if:/.test(line));

    expect(housekeepingStart).toBeGreaterThanOrEqual(0);
    expect(commitStart).toBeGreaterThan(housekeepingStart);
    expect(housekeepingBlock).toContain('JOBS_SLICE_FILE="$slice" node scripts/cleanup-jobs.mjs');
    expect(housekeepingBlock).not.toContain('JOBS_SLICE_FILE="$slice" node scripts/cleanup-jobs.mjs || true');
    expect(housekeepingBlock).not.toContain('continue-on-error: true');
    expect(commitIf).toContain('success()');
    expect(commitIf).not.toContain('always()');
  });

  it('non consuma stale-review finché non esiste un tests.yml synchronize osservato', () => {
    expect(autorebase).toContain("'--remove-label', 'stale-review'");
    expect(autorebase).toContain('function clearStaleReviewLabel');
    expect(autorebase).toContain('if (dispatchTests(num, branch)) clearStaleReviewLabel(num);');
    expect(autorebase).toContain('return false;');
    expect(autorebase).not.toMatch(/gh workflow run tests\.yml[^\n]*--ref/u);
    const postRebase = autorebase.slice(autorebase.indexOf('// Riesegui test E review'));
    expect(postRebase).toContain('dispatchTests(num, branch)');
    expect(postRebase).not.toContain('pr_number=${num}');
    expect(postRebase).not.toContain('guardedReopen(num, head');
  });

  it('lets stale-review reach autorebase even when the review gate is red', () => {
    const reviewGate = workflow.indexOf('id: review_gate');
    const autorebase = workflow.indexOf('Rebase near-merge PRs after review or stale rescue');
    const pullRequestTypes = workflow.match(
      /pull_request:\s+branches: \[main\][\s\S]*?types: \[([^\]]+)\]/,
    )?.[1];

    expect(reviewGate).toBeGreaterThanOrEqual(0);
    expect(autorebase).toBeGreaterThan(reviewGate);
    expect(pullRequestTypes).not.toContain('labeled');
    expect(workflowJobs.vitest?.if).toBeUndefined();

    // La decisione e' presa dal job required (step `post_review`) con le
    // STESSE condizioni di prima; il job `post-review` la esegue dopo.
    const decisionStart = workflow.indexOf('id: post_review');
    const decisionBlock = workflow.slice(decisionStart, workflow.indexOf('\n      - name:', decisionStart + 1));
    const expectedIf = "(job.status == 'success' && steps.review_gate.outputs.approved == 'true') || (steps.resolve.outputs.stale_review == 'true' && steps.resolve.outcome == 'success' && steps.guard.outcome == 'success' && steps.tier.outcome == 'success' && steps.prefetch.outcome == 'success' && steps.codex_review.outcome == 'success' && steps.review_abort.outcome == 'success' && steps.review_gate.outcome == 'failure')";
    expect(decisionStart).toBeGreaterThan(reviewGate);
    expect(decisionBlock).toContain(`AUTOREBASE: \${{ ${expectedIf} }}`);
    expect(decisionBlock).toMatch(/if: .*always\(\) && !cancelled\(\)/);
    const autorebaseBlock = workflow.slice(autorebase, workflow.indexOf('\n      - name:', autorebase + 1));
    expect(autorebaseBlock).toContain("if: ${{ needs.vitest.outputs.autorebase == 'true' }}");
    expect(workflowJobs['post-review']?.if).toContain("needs.vitest.outputs.autorebase == 'true'");
    expect(workflowJobs['post-review']?.if).toContain('always()');

    // Verifica il ponte completo: il rescuer produce proprio la label che
    // l'alternativa del consumer rende soddisfacibile quando il gate è rosso,
    // e la produce con un'identità che può avviare il workflow successivo.
    expect(staleRescuer).toContain('--add-label "stale-review"');
    expect(staleRescuer).toContain('run: node scripts/ci/mint-app-token.mjs');
    expect(staleRescuer).toContain('APP_ID: ${{ secrets.APP_ID }}');
    expect(staleRescuer).toContain('APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}');
    expect(staleRescuer).toContain('functions/src/githubApiHeaders.js');
    expect(staleRescuer).toContain('GH_TOKEN: ${{ env.APP_TOKEN || secrets.GITHUB_TOKEN }}');
    expect(staleRescuer).toMatch(/(?:gh|"\$TRUSTED_GH_BIN") run rerun "\$RESCUE_RUN"/);
    expect(staleRescuer).not.toContain('gh workflow run tests.yml --repo "$REPO" --ref "$BRANCH"');
    expect(staleRescuer).toContain('checkpoint manuale, nessun dispatch trusted');
    expect(staleRescuer).toContain('and .conclusion != "skipped"');
    expect(workflow).toContain('id: review_abort');
  });

  it('does not allow the drift fallback to approve a PR without LGTM', () => {
    expect(autoMergeEval).toContain("Nessuna review claude-bot approvante");
    expect(autoMergeEval).not.toContain('if (!evaluateDriftFallback())');
  });

  it('keeps Claude Important findings inside the required native-merge check', () => {
    expect(workflow).toContain('name: vitest (unit + integration)');
    expect(workflow).toContain('id: review_gate');
    expect(workflow).toContain('node "$REVIEW_POLICY_ROOT/scripts/ci/review-gate.mjs"');
    expect(reviewGate).toContain("import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';");
    expect(reviewGate).toContain('classification.blocking');
    expect(reviewGate).toContain('reviewCommit === headSha');
    expect(reviewGate).not.toContain('scripts/ci/pr-contribution-fingerprint.mjs');
    expect(nativeAutoMerge).toContain('native-automerge-gate.mjs');
    // L'opt-in non è più event-driven: nessun trigger per-PR resta su questo
    // workflow, la concessione avviene alla fine del job required e il
    // ritentativo/revoca passa dal cron di retry-native-automerge.yml.
    // Misurato sul blocco `on:` PARSATO, non sul testo: un commento che nomina
    // un trigger rimosso non deve poter far passare né fallire l'asserzione.
    expect(Object.keys((YAML.parse(nativeAutoMerge) as { on?: Record<string, unknown> }).on ?? {}))
      .toEqual(['workflow_dispatch']);
    expect(nativeAutoMergeRetry).toContain("cron: '*/20 * * * *'");
    expect(nativeAutoMergeRetry).toContain('gh pr list');
    expect(nativeAutoMergeRetry).toContain('MAX_PR_SCAN: \'100\'');
    expect(nativeAutoMergeRetry).toContain('sort_by(.createdAt) | reverse | .[].number');
    expect(nativeAutoMergeRetry).not.toContain('.[:$max][]');
    expect(nativeAutoMergeRetry).not.toContain("jq -e '.autoMergeRequest != null'");
    expect(nativeAutoMerge).not.toContain('auto-merge-eval.mjs');
  });

  it('review_gate still runs when codex_review has outcome == failure (no outcome != failure skip)', () => {
    const start = workflow.indexOf('id: review_gate');
    expect(start).toBeGreaterThanOrEqual(0);
    const gateBlock = workflow.slice(start, start + 1200);
    const ifLine = gateBlock.split('\n').find((l) => /^\s+if:/.test(l));
    expect(ifLine, 'review_gate must have a job-step if:').toBeTruthy();
    expect(ifLine).toContain('always()');
    expect(ifLine).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(ifLine).not.toMatch(/steps\.codex_review\.outcome\s*!=\s*'failure'/);
  });

  it('makes provider rate limits visible and retryable instead of suppressing them for quota protection', () => {
    const abortStart = workflow.indexOf('id: review_abort');
    const gateStart = workflow.indexOf('id: review_gate');
    const abortBlock = workflow.slice(abortStart, gateStart);

    expect(abortStart).toBeGreaterThanOrEqual(0);
    expect(abortBlock).toContain("grep -q '^rate_limited=true$'");
    expect(abortBlock).toContain('stale-pr-rescuer');
    expect(abortBlock).toContain('exit 1');
    expect(abortBlock).not.toContain('NOT failing');
    expect(abortBlock).not.toContain('shared Max quota');
    expect(workflow).not.toContain('QUOTA_LEASE_ACTION');
  });

  it('lets the red-flag fixer act only when scope is blocking or unverifiable', () => {
    expect(redflagFixer).toContain('scope:');
    expect(redflagFixer).toContain('node scripts/ci/review-gate.mjs --scope');
    expect(redflagFixer).toContain('blocking: ${{ steps.scope.outputs.blocking }}');
    expect(redflagFixer).toContain('error: ${{ steps.scope.outputs.error }}');
    expect(redflagFixer).toContain('needs: [preflight, scope]');
    expect(redflagFixer).toContain("always() && needs.preflight.outputs.actionable == 'true'");
    expect(redflagFixer).toContain("needs.scope.result != 'success' || needs.scope.outputs.blocking == 'true' || needs.scope.outputs.error == 'true'");
    expect(redflagFixer).toContain('REVIEW_SCOPE_MUTATE: \'true\'');
    expect(reviewGate).toContain('const title = `follow-up(#${pr}): finding fuori dal diff`');
    expect(reviewGate).toContain('reopenWithinHours: 0');
  });
});
