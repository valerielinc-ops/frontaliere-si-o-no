import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');

const WORKFLOW_HELPER_WRITERS = [
  '.github/workflows/batch-faq-articles.yml',
  '.github/workflows/build-evidence-and-tune.yml',
  '.github/workflows/cwv-monitor.yml',
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

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('main data writers use the shared retry contract', () => {
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
    const buildHistoryWriter = read('scripts/lib/append-build-history-row.sh');
    expect(buildHistoryWriter).toContain('git-push-with-retry.sh --max-attempts 5 --stash-dirty');
    expect(buildHistoryWriter).toContain('scripts/ci/assert-accumulator-write.mjs');
    expect(buildHistoryWriter).toContain('git commit --only -m "$HISTORY_COMMIT_MSG" -- "$history_path"');
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

  it('bounds the CWV snapshot retry budget below its job timeout', () => {
    const workflow = read('.github/workflows/cwv-monitor.yml');
    const document = YAML.parse(workflow) as {
      jobs?: {
        monitor?: {
          'timeout-minutes'?: number;
          steps?: Array<{ name?: string; run?: string }>;
        };
      };
    };
    const monitorJob = document.jobs?.monitor;
    const snapshotStep = monitorJob?.steps?.find(
      (step) => step.name === 'Commit weekly snapshot if changed',
    );
    const maxAttempts = snapshotStep?.run?.match(/--max-attempts\s+(\d+)/)?.[1];

    expect(monitorJob, 'CWV monitor job is missing').toBeDefined();
    expect(snapshotStep, 'CWV snapshot commit step is missing').toBeDefined();
    expect(maxAttempts, 'CWV snapshot retry cap is missing').toBe('8');
    expect(Number(maxAttempts)).toBeLessThan(monitorJob?.['timeout-minutes'] ?? 0);
  });

  it('keeps generated build snapshots out of history checkpoint commits', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toContain('node scripts/ci/assert-accumulator-write.mjs "$accumulator"');
    expect(deploy).toContain('git commit --only \\');
    expect(deploy).toContain('-m "chore(dist-history): append run ${GITHUB_RUN_ID} (${GITHUB_SHA::8})" \\');
    expect(deploy).toContain('-- data/dist-size-history.jsonl data/url-first-seen.json');
  });
});
