import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const WORKFLOW_HELPER_WRITERS = [
  '.github/workflows/batch-faq-articles.yml',
  '.github/workflows/build-evidence-and-tune.yml',
  '.github/workflows/crawler-health-monitor.yml',
  '.github/workflows/evergreen-pool-snapshot.yml',
  '.github/workflows/fb-events-daily-schedule.yml',
  '.github/workflows/funnel-metrics-snapshot.yml',
  '.github/workflows/gsc-frontaliere-monitor.yml',
  '.github/workflows/guard-data-integrity.yml',
  '.github/workflows/prospector-loop.yml',
  '.github/workflows/quality-alerts.yml',
  '.github/workflows/refresh-gsc-marquee-demand.yml',
  '.github/workflows/regenerate-visual-baselines.yml',
  '.github/workflows/sync-pharmacies-border.yml',
  '.github/workflows/update-weather.yml',
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

  it('keeps the data-specific replay contracts', () => {
    const pharmacyWorkflow = read('.github/workflows/sync-pharmacies-border.yml');
    const dutyFetch = pharmacyWorkflow.indexOf('node scripts/sync-pharmacy-duties.mjs || duty_exit=$?');
    const finalizer = pharmacyWorkflow.indexOf('npm run pharmacies:import', dutyFetch);
    const checker = pharmacyWorkflow.indexOf('npm run pharmacies:check', finalizer);
    expect(pharmacyWorkflow).toContain("--regenerate-cmd '");
    expect(pharmacyWorkflow).toContain('case "$duty_exit" in');
    expect(pharmacyWorkflow).toContain('0|1|2)');
    expect(pharmacyWorkflow).toContain('duty fetch diagnostic exit=$duty_exit; continuing to atomic finalizer');
    expect(pharmacyWorkflow).toContain('atomic finalizer completed after duty diagnostic exit=$duty_exit');
    expect(pharmacyWorkflow).toContain('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json');
    expect(dutyFetch).toBeGreaterThan(-1);
    expect(finalizer).toBeGreaterThan(dutyFetch);
    expect(checker).toBeGreaterThan(finalizer);
    expect(read('.github/workflows/crawler-health-monitor.yml')).toContain(
      'node scripts/check-crawler-health.mjs || true; git add data/crawler-health.json',
    );
    expect(read('.github/workflows/guard-data-integrity.yml')).toContain(
      'node scripts/ci/restore-data-integrity-files.mjs',
    );
    expect(read('.github/workflows/deploy.yml')).toContain('--stash-dirty');
    expect(read('scripts/lib/append-build-history-row.sh')).toContain(
      'git-push-with-retry.sh --max-attempts 5 --stash-dirty',
    );
  });
});
