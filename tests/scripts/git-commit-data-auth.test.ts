import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/lib/git-commit-data.sh');

describe('scripts/lib/git-commit-data.sh authentication', () => {
  it('configures GitHub auth before fetch/push operations with ruleset bypass credentials', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const configureIndex = source.indexOf('ensure_git_auth()');
    const callIndex = source.indexOf('ensure_git_auth', configureIndex + 1);
    // `git fetch origin main` is wrapped in a git_fetch_retry() helper (retry
    // on transient network errors under set -e — issue #3771/#3774) whose
    // definition appears before the first real call site, so indexOf('git
    // fetch origin main') now matches inside the helper's own body instead of
    // an actual invocation. Locate the first real *call* of the helper
    // (its definition + the following occurrence) instead.
    const fetchDefIndex = source.indexOf('git_fetch_retry()');
    const fetchCallIndex = source.indexOf('git_fetch_retry', fetchDefIndex + 1);
    const pushIndex = source.indexOf('git push origin main');

    expect(configureIndex).toBeGreaterThan(-1);
    expect(source).toContain('configure-main-push-auth.sh');
    expect(source).not.toContain('GH_TOKEN:-${GITHUB_TOKEN:-}');
    expect(source).not.toContain('CHECKOUT_GIT_EXTRAHEADER=');
    expect(callIndex).toBeGreaterThan(configureIndex);
    expect(callIndex).toBeLessThan(fetchCallIndex);
    expect(callIndex).toBeLessThan(pushIndex);
  });
});
