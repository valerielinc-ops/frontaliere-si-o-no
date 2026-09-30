import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), 'utf8');

const WORKFLOWS = [
  {
    path: '.github/workflows/discover-404s.yml',
    branch: 'chore/discover-404s-url-inspection',
    paths: ['data/seo-404-compat', 'data/inspection-state.json'],
  },
  {
    path: '.github/workflows/discover-404s-via-cloudflare.yml',
    branch: 'chore/discover-404s-cloudflare',
    paths: ['data/seo-404-compat', 'data/cf-hot-404s.json'],
  },
] as const;

describe('404 discovery workflows publish protected data through PRs', () => {
  it.each(WORKFLOWS)('$path uses the shared PR publisher', ({ path, branch, paths }) => {
    const workflow = read(path);

    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/^\s*git\s+push\b/m);
    expect(workflow).not.toContain('trigger-deploy.sh');
    expect(workflow).toContain(`--branch ${branch}`);
    for (const dataPath of paths) {
      expect(workflow).toContain(`--path ${dataPath}`);
    }
  });

  it('uses the repository bot identity for generated data commits', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher).toContain('git add -A -- "${PATHS[@]}"');
    expect(publisher).toContain('frontaliere-automation[bot]');
    expect(publisher).toContain('296434481+frontaliere-automation[bot]@users.noreply.github.com');
  });
});
