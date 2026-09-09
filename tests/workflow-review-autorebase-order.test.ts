import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const reviewGate = readFileSync(new URL('../scripts/ci/review-gate.mjs', import.meta.url), 'utf8');
const staleRescuer = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');
const autorebase = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const autoMergeEval = readFileSync(new URL('../scripts/ci/auto-merge-eval.mjs', import.meta.url), 'utf8');
const nativeAutoMerge = readFileSync(new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url), 'utf8');
const redflagFixer = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');

describe('review → autorebase ordering', () => {
  it('consuma stale-review dopo un re-trigger riuscito, senza perdere il rescue se fallisce', () => {
    expect(autorebase).toContain("'--remove-label', 'stale-review'");
    expect(autorebase).toContain('function clearStaleReviewLabel');
    expect(autorebase).toContain('if (dispatchTests(num, branch)) clearStaleReviewLabel(num);');
    expect(autorebase).toContain('if (guardedReopen(num, head)) clearStaleReviewLabel(num);');
  });

  it('lets stale-review reach autorebase even when the review gate is red', () => {
    const reviewGate = workflow.indexOf('id: review_gate');
    const autorebase = workflow.indexOf('Rebase near-merge PRs after review or stale rescue');
    const pullRequestTypes = workflow.match(
      /pull_request:\s+branches: \[main\][\s\S]*?types: \[([^\]]+)\]/,
    )?.[1];

    expect(reviewGate).toBeGreaterThanOrEqual(0);
    expect(autorebase).toBeGreaterThan(reviewGate);
    expect(pullRequestTypes).toContain('labeled');
    expect(workflow).not.toContain(
      "if: ${{ github.event.action != 'edited' && (github.event.action != 'labeled' || contains(github.event.pull_request.labels.*.name, 'stale-review')) }}",
    );

    const autorebaseBlock = workflow.slice(autorebase, workflow.indexOf('\n      - name:', autorebase + 1));
    const mint = workflow.indexOf('name: Mint autorebase App token');
    const mintBlock = workflow.slice(mint, workflow.indexOf('\n      - name:', mint + 1));
    const expectedIf = "(success() && steps.review_gate.outputs.approved == 'true') || (!cancelled() && github.event.action == 'labeled' && steps.resolve.outcome == 'success' && steps.guard.outcome == 'success' && steps.tier.outcome == 'success' && steps.prefetch.outcome == 'success' && steps.claude_review.outcome == 'success' && steps.review_abort.outcome == 'success' && steps.review_gate.outcome == 'failure' && contains(github.event.pull_request.labels.*.name, 'stale-review'))";
    for (const block of [mintBlock, autorebaseBlock]) {
      const ifLine = block.split('\n').find((line) => /^\s+if:/.test(line));
      expect(ifLine).toBeTruthy();
      expect(ifLine).toContain(expectedIf);
    }

    // Verifica il ponte completo: il rescuer produce proprio la label che
    // l'alternativa del consumer rende soddisfacibile quando il gate è rosso,
    // e la produce con un'identità che può avviare il workflow successivo.
    expect(staleRescuer).toContain('--add-label "stale-review"');
    expect(staleRescuer).toContain('run: node scripts/ci/mint-app-token.mjs');
    expect(staleRescuer).toContain('APP_ID: ${{ secrets.APP_ID }}');
    expect(staleRescuer).toContain('APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}');
    expect(staleRescuer).toContain('functions/src/githubApiHeaders.js');
    expect(staleRescuer).toContain('GH_TOKEN: ${{ env.APP_TOKEN || secrets.GITHUB_TOKEN }}');
    expect(staleRescuer).toContain('continue-on-error: true');
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
    expect(workflow).toContain('node scripts/ci/review-gate.mjs');
    expect(reviewGate).toContain("import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';");
    expect(reviewGate).toContain('classification.blocking');
    expect(reviewGate).toContain('reviewCommit === headSha');
    expect(reviewGate).toContain('scripts/ci/pr-contribution-fingerprint.mjs');
    expect(nativeAutoMerge).toContain('gh pr merge "$PR_NUMBER" --repo "$REPOSITORY" --auto');
    expect(nativeAutoMerge).not.toContain('auto-merge-eval.mjs');
  });

  it('review_gate still runs when claude_review has outcome == failure (no outcome != failure skip)', () => {
    const start = workflow.indexOf('id: review_gate');
    expect(start).toBeGreaterThanOrEqual(0);
    const gateBlock = workflow.slice(start, start + 1200);
    const ifLine = gateBlock.split('\n').find((l) => /^\s+if:/.test(l));
    expect(ifLine, 'review_gate must have a job-step if:').toBeTruthy();
    expect(ifLine).toContain('always()');
    expect(ifLine).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(ifLine).not.toMatch(/steps\.claude_review\.outcome\s*!=\s*'failure'/);
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
