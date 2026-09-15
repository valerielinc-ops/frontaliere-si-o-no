import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/funnel-metrics-snapshot.yml', import.meta.url),
  'utf8',
);

describe('funnel-metrics-snapshot persistence contract', () => {
  it('delegates branch-aware rebase and push to the shared retry helper', () => {
    expect(workflow).toContain('PUSH_BRANCH="${GITHUB_REF_NAME:-main}"');
    expect(workflow).toContain('bash scripts/lib/git-push-with-retry.sh');
    expect(workflow).toContain('--branch "$PUSH_BRANCH"');
    expect(workflow).toContain('--max-attempts 3');
    expect(workflow).not.toContain('git pull --rebase origin main');
    expect(workflow).not.toContain('git pull --rebase origin "$PUSH_BRANCH"');
  });
});
