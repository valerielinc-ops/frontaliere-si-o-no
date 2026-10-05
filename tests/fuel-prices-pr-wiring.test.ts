import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), 'utf8');

describe('fuel price refresh publication', () => {
  it('publishes ignored fuel caches through the shared PR path', () => {
    const workflow = read('.github/workflows/update-fuel-prices.yml');

    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('scripts/load-rc-env.mjs');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).toContain('--force');
    expect(workflow).toContain('--path data/fuel-prices.json');
    expect(workflow).toContain('--path public/data/fuel-prices.json');
    expect(workflow).toContain('--path data/fuel-prices-history/');
    expect(workflow).toContain('--branch chore/refresh-fuel-prices');
    expect(workflow).toContain('required check \\`vitest (unit + integration)\\` valida');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toContain('scripts/lib/trigger-deploy.sh');
    expect(workflow).not.toMatch(/\bgit\s+push\b/);
  });

  it('builds the canton dataset from the daily hand-off without blocking the main cache PR', () => {
    const workflow = read('.github/workflows/update-fuel-prices.yml');
    const gitignore = read('.gitignore');

    // The generator hands its full station lists over instead of the canton
    // step re-fetching TCS/MIMIT.
    expect(workflow).toContain('--save-local --cantons-input-out "$RUNNER_TEMP/fuel-cantons-input.json"');
    expect(workflow).toContain('node scripts/build-fuel-cantons-dataset.mjs --input "$RUNNER_TEMP/fuel-cantons-input.json"');
    const step = workflow.slice(workflow.indexOf('- name: Build cantonal fuel dataset (P9b)'));
    expect(step.slice(0, step.indexOf('run:'))).toContain('continue-on-error: true');
    // Its failure is still surfaced, under a title of its own.
    expect(workflow).toContain("if: steps.fuel_cantons.outcome == 'failure'");
    expect(workflow).toContain('--title "Dataset carburanti per cantone rifiutato (update-fuel-prices)"');
    // Joins the same refresh PR only once the file exists (untracked before
    // its first successful build), with the same ignored-cache contract.
    expect(workflow).toContain('if [ -f data/fuel-prices-cantons.json ] && [ -f public/data/fuel-prices-cantons.json ]; then');
    expect(workflow).toContain('"${cantons_paths[@]}"');
    expect(workflow.indexOf('Build cantonal fuel dataset (P9b)')).toBeLessThan(workflow.indexOf('Open PR with fuel price cache'));
    expect(gitignore).toContain('data/fuel-prices-cantons.json');
    expect(gitignore).toContain('public/data/fuel-prices-cantons.json');
  });

  it('supports force-staging only when a refresh explicitly opts in', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher).toContain('FORCE_ADD=false');
    expect(publisher).toContain('--force');
    expect(publisher).toContain('git add -A -f -- "${PATHS[@]}"');
    expect(publisher).toContain('git add -A -- "${PATHS[@]}"');
  });
});
