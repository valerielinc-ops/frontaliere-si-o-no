import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOWS = resolve(import.meta.dirname, '../.github/workflows');
const BORDER_IMPORTER = resolve(import.meta.dirname, '../scripts/import-pharmacies-border.mjs');

describe('pharmacy atomic refresh workflow', () => {
  it('retries transient official-source failures without weakening the importer gates', () => {
    const source = readFileSync(BORDER_IMPORTER, 'utf8');
    expect(source).toContain("httpFetchWithRetry,");
    expect(source).toContain("isConnectionLevelFetchError,");
    expect(source).toContain("isRetryBudgetExhausted,");
    expect(source).toContain("transportErrorKind,");
    expect(source).toContain('response = await httpFetchWithRetry(url,');
    expect(source).toContain("const wrapped = new Error(`Failed to fetch ${url} (${kind}): ${message}`, { cause: error });");
    expect(source).toContain('if (!response.ok) {');
    expect(source).toContain('const error = new Error(`HTTP ${response.status} for ${url}`);');
    expect(source).toContain('preserving the previous snapshot');
  });

  it('publishes fresh duties beside a preserved Ticino catalogue in a new release', () => {
    const source = readFileSync(BORDER_IMPORTER, 'utf8');
    expect(source).toContain('const publishTicinoRelease = !allDutiesFailed;');
    expect(source).toContain('if (publishTicinoRelease) {');
    expect(source).toContain('publishing the fresh duty snapshot in a new atomic release while retaining the fallback marker');
    expect(source).toContain('all duty regions failed; retaining the previous atomic catalogue+duties+status release');
  });

  it('keeps the duty alias free of a release-less main writer', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacy-duties.yml'), 'utf8');
    expect(source).toContain('workflow_dispatch: {}');
    expect(source).toContain("cron: '*/15 * * * *'");
    expect(source).toContain('uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(source).not.toMatch(/\bgit push\b/);
    expect(source).not.toContain('node scripts/sync-pharmacy-duties.mjs');
  });

  it('stages duties and finalizes them in the same border writer job', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    expect(source).toContain('workflow_call:');
    expect(source).toContain('continue-on-error: true');
    expect(source.match(/PHARMACY_DUTY_STAGE_DIR/g)).toHaveLength(2);
    expect(source).toContain('run: npm run pharmacies:import');
  });

  it('keeps finalization before PR publication after duty diagnostics', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    const dutyFetch = source.indexOf('node scripts/sync-pharmacy-duties.mjs');
    const finalizer = source.indexOf('run: npm run pharmacies:import');
    const checker = source.indexOf('run: npm run pharmacies:check');
    const publisher = source.indexOf('scripts/lib/open-data-refresh-pr.sh');

    expect(source).toContain('continue-on-error: true');
    expect(dutyFetch).toBeGreaterThan(-1);
    expect(finalizer).toBeGreaterThan(dutyFetch);
    expect(checker).toBeGreaterThan(finalizer);
    expect(publisher).toBeGreaterThan(checker);
    const archive = source.indexOf('run: npx --no-install tsx scripts/archive-pharmacy-duty-weeks.mts');
    expect(archive).toBeGreaterThan(checker);
    expect(publisher).toBeGreaterThan(archive);
    const archiveStep = source.slice(source.lastIndexOf('- name:', archive), source.indexOf('\n      - name:', archive + 1));
    expect(archiveStep).toContain('continue-on-error: true');
    expect(source).toContain('--path data/pharmacy-duty-week-history');
    expect(source).toContain('git status --porcelain -- public/data/pharmacy-duty-cantons.json data/pharmacy-duty-week-history');
  });

  it('publishes every atomic snapshot through the protected PR publisher', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    expect(source).toContain('pull-requests: write');
    expect(source).toContain('GH_TOKEN: ${{ env.GITHUB_PAT }}');
    expect(source).toContain('## Implementato');
    expect(source).toContain('## Non implementato (ancora)');
    expect(source).toContain('--branch chore/refresh-pharmacies-border');
    expect(source).toContain('--commit-message "chore(data): refresh atomic cross-border pharmacy release"');
    expect(source).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(source).not.toContain('--regenerate-cmd');
    for (const path of [
      'data/pharmacies-ticino-complete.json',
      'data/pharmacies-italy-border.json',
      'data/pharmacy-duties-ticino.json',
      'data/pharmacy-duties-ticino-status.json',
      'data/pharmacy-duties-geneva.json',
      'data/pharmacy-duties-geneva-status.json',
      'data/pharmacy-duties-swiss-cantons.json',
      'data/pharmacy-sources-registry.json',
    ]) expect(source).toContain(`--path ${path}`);
  });
});
