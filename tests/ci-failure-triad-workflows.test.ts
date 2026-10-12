import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
// @ts-expect-error — plain .mjs CI gate
import { validatePrBody } from '../scripts/ci/pr-body-check-gate.mjs';

const WORKFLOW_DIR = '.github/workflows';

function workflow(name: string): any {
  return YAML.parse(fs.readFileSync(`${WORKFLOW_DIR}/${name}`, 'utf8'));
}

describe('CI failure triad workflow regressions (#12926, #12902)', () => {
  it('validates the event-image data PR body with the same strict gate used before writes', () => {
    const steps = workflow('event-image-library.yml').jobs.generate.steps;
    const publish = steps.find((step: any) => step.name === 'Publish registry through a data PR');
    const body = /cat > "\$body" <<'EOF'\n([\s\S]*?)\nEOF/u.exec(publish?.run || '')?.[1];

    expect(body, 'event-image PR body heredoc').toBeTruthy();
    const result = validatePrBody(body);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fetches only required workflow inputs and branch history for the profession writer', () => {
    const steps = workflow('profession-keyword-opportunities.yml').jobs.rank.steps;
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
    const historyIndex = steps.findIndex((step: any) => step.name === 'Fetch blobless history for push retries');
    const setupNodeIndex = steps.findIndex((step: any) => step.uses?.startsWith('actions/setup-node@'));
    const sparsePaths = String(checkout?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const history = steps[historyIndex];

    expect(checkout?.with?.ref).toBe('${{ github.ref }}');
    expect(checkout?.with?.['fetch-depth']).toBe(1);
    expect(checkout?.with?.filter).toBeUndefined();
    expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
    expect(sparsePaths).toEqual(expect.arrayContaining([
      '/build-plugins/professionLandingsData.ts',
      '/data/gsc-orphan-queries.json',
      '/data/jobs.json',
      '/data/jobs/by-crawler/',
      '/data/keyword-pages-config.json',
      '/data/profession-keyword-opportunities.json',
      '/package-lock.json',
      '/scripts/lib/',
      '/scripts/load-rc-env.mjs',
      '/scripts/profession-keyword-opportunities.mjs',
    ]));
    expect(historyIndex).toBeGreaterThan(steps.indexOf(checkout));
    expect(historyIndex).toBeLessThan(setupNodeIndex);
    expect(history?.['timeout-minutes']).toBe(5);
    expect(history?.env?.BRANCH).toBe('${{ github.ref_name }}');
    expect(history?.run).toContain('git fetch --no-tags --filter=blob:none --unshallow origin');
    expect(history?.run).toContain('"+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"');
    expect(history?.run).toContain('"+refs/heads/main:refs/remotes/origin/main"');
    expect(history?.run).not.toMatch(/\+refs\/(?:heads|tags)\/\*/u);
  });
});
