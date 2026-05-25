import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/lib/git-commit-data.sh');

describe('scripts/lib/git-commit-data.sh authentication', () => {
  it('configures GitHub auth before fetch/push operations without stale Remote Config PATs', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const configureIndex = source.indexOf('ensure_git_auth()');
    const callIndex = source.indexOf('ensure_git_auth', configureIndex + 1);
    const fetchIndex = source.indexOf('git fetch origin main');
    const pushIndex = source.indexOf('git push origin main');

    expect(configureIndex).toBeGreaterThan(-1);
    expect(source).toContain('GH_TOKEN:-${GITHUB_TOKEN:-}');
    expect(source).toContain('CHECKOUT_GIT_EXTRAHEADER=');
    expect(source).not.toContain('GITHUB_PAT:-');
    expect(source).toContain('git config --local http.https://github.com/.extraheader');
    expect(callIndex).toBeGreaterThan(configureIndex);
    expect(callIndex).toBeLessThan(fetchIndex);
    expect(callIndex).toBeLessThan(pushIndex);
  });
});
