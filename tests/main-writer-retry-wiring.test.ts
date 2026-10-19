import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');

// This catalog covers workflows that still write directly to protected main.
// PR-backed refreshes delegate branch publication to
// scripts/lib/open-data-refresh-pr.sh and are covered by
// tests/data-refresh-pr-wiring.test.ts instead.
const WORKFLOW_HELPER_WRITERS = [
  '.github/workflows/batch-faq-articles.yml',
  '.github/workflows/evergreen-pool-snapshot.yml',
  '.github/workflows/fb-events-daily-schedule.yml',
  '.github/workflows/funnel-metrics-snapshot.yml',
  '.github/workflows/gsc-frontaliere-monitor.yml',
  '.github/workflows/guard-data-integrity.yml',
  '.github/workflows/prospector-loop.yml',
  '.github/workflows/quality-alerts.yml',
  '.github/workflows/refresh-gsc-marquee-demand.yml',
  '.github/workflows/regenerate-visual-baselines.yml',
];

const STATE_ONLY_MONITORS = [
  '.github/workflows/auth-signup-subscriber-monitor.yml',
  '.github/workflows/autologin-refusal-monitor.yml',
  '.github/workflows/unsubscribe-credential-monitor.yml',
];

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('main data writers use the shared retry contract', () => {
  it('routes the direct main writers through the anti-collapse guard', () => {
    const retryWriter = read('scripts/lib/git-push-with-retry.sh');
    const dataWriter = read('scripts/lib/git-commit-data.sh');
    const browserWriter = read('scripts/social-robot/persist-browser-insights.mjs');
    const corpusMirror = read('.github/workflows/mirror-articles-corpus.yml');

    expect(retryWriter).toContain('main-push-guard.mjs');
    expect(retryWriter).toContain('--timeout-seconds "$GIT_PUSH_WITH_RETRY_PUSH_TIMEOUT_SECONDS"');
    expect(retryWriter).toContain('--push');
    expect(retryWriter).toContain('--candidate "$candidate_sha"');
    expect(retryWriter).not.toContain('--check-only');
    expect(dataWriter).toContain('main_push_guard_check');
    expect(dataWriter).toContain('PUSH_CANDIDATE_SHA');
    expect(dataWriter).toContain('guarded_push_remaining_seconds');
    expect(dataWriter).toContain('run_bounded "$push_timeout"');
    expect(dataWriter).toContain('run_bounded "$PUSH_TIMEOUT"');
    expect(dataWriter).toContain('--force-with-lease=refs/heads/main:');
    expect(dataWriter).not.toContain('origin HEAD:main');
    expect(dataWriter).not.toContain('date +%s');
    expect(browserWriter).toContain("import { pushMainWithGuard } from '../lib/main-push-guard.mjs'");
    expect(browserWriter).not.toContain("'--check-only'");
    expect(corpusMirror).toContain('main-push-guard.mjs');
    expect(corpusMirror).toContain('--push');
  });

  it('bounds the mirror job, publication step, clone, fetch and retry loop', () => {
    const document = YAML.parse(read('.github/workflows/mirror-articles-corpus.yml')) as {
      jobs?: {
        mirror?: {
          'timeout-minutes'?: number;
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string | number>;
            'timeout-minutes'?: number;
          }>;
        };
      };
    };
    const mirror = document.jobs?.mirror;
    const pushStep = mirror?.steps?.find((step) => step.name === 'Push packages/articles to the articles repo');

    expect(mirror?.['timeout-minutes']).toBe(15);
    expect(pushStep?.['timeout-minutes']).toBe(12);
    expect(pushStep?.env?.MIRROR_RETRY_BUDGET_SECONDS).toBe('540');
    expect(Number(pushStep?.env?.MIRROR_RETRY_BUDGET_SECONDS)).toBeLessThanOrEqual((15 - 5) * 60);
    expect(Number(pushStep?.env?.MIRROR_RETRY_BUDGET_SECONDS)).toBeLessThanOrEqual(12 * 60);
    expect(pushStep?.run).toContain('mirror_deadline=$((SECONDS + MIRROR_RETRY_BUDGET_SECONDS))');
    expect(pushStep?.run).toContain('run_bounded "clone articles mirror target" "$timeout_seconds"');
    expect(pushStep?.run).toContain('run_bounded "fetch articles mirror base (attempt ${attempt}/3)" "$timeout_seconds"');
    expect(pushStep?.run).toContain('mirror_timeout_seconds');
    expect(pushStep?.run).toContain('--candidate "$candidate_sha"');
    expect(pushStep?.run).toContain('for attempt in 1 2 3; do');
  });

  it('does not leave a bespoke main push in the audited writer workflows', () => {
    for (const relativePath of WORKFLOW_HELPER_WRITERS) {
      const source = read(relativePath);
      expect(source, `${relativePath} must call git-push-with-retry.sh`).toContain(
        'scripts/lib/git-push-with-retry.sh',
      );
      const executablePushes = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\bgit push\b/.test(line) && !line.startsWith('#'));
      expect(executablePushes, `${relativePath} still has an inline git push`).toEqual([]);
    }
  });

  it('keeps the pharmacy PR publication contract', () => {
    const pharmacyWorkflow = read('.github/workflows/sync-pharmacies-border.yml');
    const finalizer = pharmacyWorkflow.indexOf('run: npm run pharmacies:import');
    const checker = pharmacyWorkflow.indexOf('run: npm run pharmacies:check');
    const publisher = pharmacyWorkflow.indexOf('scripts/lib/open-data-refresh-pr.sh');
    expect(pharmacyWorkflow).toContain('pull-requests: write');
    expect(pharmacyWorkflow).toContain('GH_TOKEN: ${{ env.GITHUB_PAT }}');
    expect(pharmacyWorkflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(pharmacyWorkflow).not.toContain('--regenerate-cmd');
    expect(finalizer).toBeGreaterThan(-1);
    expect(checker).toBeGreaterThan(finalizer);
    expect(publisher).toBeGreaterThan(checker);
    expect(read('.github/workflows/guard-data-integrity.yml')).toContain(
      'node scripts/ci/restore-data-integrity-files.mjs',
    );
    expect(read('.github/workflows/deploy.yml')).toContain('--stash-dirty');
    // build-history: the matrix legs only stage rows (#9247); the single
    // writer is scripts/lib/commit-build-history-rows.sh, run once per deploy
    // by the build-history-commit job on a clean sparse checkout, so it
    // regenerates the append on origin/main instead of stashing a dirty tree.
    // Only the wiring is checked here; the exact behaviour (no git in the
    // stager, one commit, dedup against main) lives in
    // tests/build-history-single-writer.test.ts.
    expect(read('scripts/lib/append-build-history-row.sh')).not.toContain('git-push-with-retry.sh');
    const buildHistoryWriter = read('scripts/lib/commit-build-history-rows.sh');
    expect(buildHistoryWriter).toContain('git-push-with-retry.sh');
    expect(buildHistoryWriter).toContain('--regenerate-cmd');
    expect(buildHistoryWriter).toContain('scripts/ci/assert-accumulator-write.mjs');
  });

  it('routes the exchange snapshot through the protected PR publisher', () => {
    const workflow = read('.github/workflows/update-exchange-history.yml');
    const document = YAML.parse(workflow) as {
      jobs?: {
        update?: {
          'timeout-minutes'?: number;
          steps?: Array<{ name?: string; run?: string }>;
        };
      };
    };
    const updateJob = document.jobs?.update;

    expect(updateJob, 'exchange history update job is missing').toBeDefined();
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(updateJob?.['timeout-minutes']).toBeGreaterThanOrEqual(15);
  });

  it('keeps state-only monitor commit-backs isolated and bounded', () => {
    for (const relativePath of STATE_ONLY_MONITORS) {
      const document = YAML.parse(read(relativePath)) as {
        jobs?: Record<string, {
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string | number>;
          }>;
        }>;
      };
      const commitStep = Object.values(document.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.name?.startsWith('Commit history'));

      expect(commitStep, `${relativePath} is missing its history commit step`).toBeDefined();
      expect(commitStep?.run, `${relativePath} must use the extra-only writer path`).toContain(
        'git-commit-data.sh --extra-only',
      );
      expect(commitStep?.env?.MAX_PUSH_ATTEMPTS, `${relativePath} must cap push retries`).toBe('5');
    }
  });

  it('keeps generated build snapshots out of history checkpoint commits', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toContain('node scripts/ci/assert-accumulator-write.mjs "$accumulator"');
    expect(deploy).toContain('git commit --only \\');
    expect(deploy).toContain('-m "chore(dist-history): append run ${GITHUB_RUN_ID} (${GITHUB_SHA::8})" \\');
    expect(deploy).toContain('-- data/dist-size-history.jsonl data/url-first-seen.json');
  });
});
