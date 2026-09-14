import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/funnel-metrics-snapshot.yml', import.meta.url),
  'utf8',
);

describe('funnel-metrics-snapshot persistence contract', () => {
  it('rebases and pushes the ref that the workflow actually checked out', () => {
    expect(workflow).toContain('PUSH_BRANCH="${GITHUB_REF_NAME:-main}"');
    expect(workflow).toContain('git pull --rebase origin "$PUSH_BRANCH"');
    expect(workflow).toContain('git push origin "HEAD:$PUSH_BRANCH"');
    expect(workflow).not.toContain('git pull --rebase origin main');
  });
});
