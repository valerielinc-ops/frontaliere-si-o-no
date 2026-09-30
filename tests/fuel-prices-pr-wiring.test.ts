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
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toContain('scripts/lib/trigger-deploy.sh');
    expect(workflow).not.toMatch(/\bgit\s+push\b/);
  });

  it('supports force-staging only when a refresh explicitly opts in', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher).toContain('FORCE_ADD=false');
    expect(publisher).toContain('--force');
    expect(publisher).toContain('git add -A -f -- "${PATHS[@]}"');
    expect(publisher).toContain('git add -A -- "${PATHS[@]}"');
  });
});
