/**
 * Every workflow that pushes THIS repo's `main` must have a ruleset-bypass
 * credential path. The ambient Actions GITHUB_TOKEN is rejected with GH013.
 *
 * Credential path = load-rc-env.mjs (GITHUB_PAT) and/or mint-app-token.mjs
 * (APP_TOKEN). Shared helpers fail-closed on those env vars; inline `git push`
 * writers must also call configure-main-push-auth.sh (or the equivalent
 * extraheader-unset + x-access-token rewrite).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../.github/workflows');
const DISABLED_CRAWLER = /^crawler-group-\d+\.yml$/;
const FOREIGN_REMOTE = new Set([
  'apply-generator-rewire-to-nanako.yml',
  'transport-generator-to-nanako.yml',
  'mirror-articles-corpus.yml',
  'mirror-articles-engine.yml',
]);

function codeOf(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function isHelperWriter(code: string): boolean {
  return (
    code.includes('git-push-with-retry.sh') ||
    code.includes('git-commit-data.sh') ||
    code.includes('configure-main-push-auth.sh')
  );
}

function isInlineThisRepoMainPush(code: string): boolean {
  return code.split('\n').some((raw) => {
    const line = raw.trim();
    if (!/\bgit push\b/.test(line)) return false;
    if (/^(echo|printf)\b/.test(line)) return false;
    if (/TARGET_BRANCH|head\.ref|fix\/issue-/.test(line)) return false;
    if (/HEAD:\$\{/.test(line) && !/HEAD:main/.test(line)) return false;
    return (
      /HEAD:main/.test(line) ||
      /\borigin main\b/.test(line) ||
      /git push origin HEAD:main/.test(line) ||
      /&& git push\b/.test(line) ||
      /git push &&/.test(line)
    );
  });
}

function hasCredentialLoad(code: string): boolean {
  return code.includes('load-rc-env.mjs') || code.includes('mint-app-token.mjs');
}

function hasInlineConfigure(code: string): boolean {
  if (code.includes('configure-main-push-auth.sh')) return true;
  return (
    /unset-all/.test(code) &&
    /x-access-token:/.test(code) &&
    /APP_TOKEN|GITHUB_PAT/.test(code)
  );
}

describe('this-repo main writers have a ruleset-bypass credential path', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  it('every helper / inline main writer loads GITHUB_PAT or mints APP_TOKEN', () => {
    const missing: string[] = [];
    for (const file of files) {
      if (DISABLED_CRAWLER.test(file) || FOREIGN_REMOTE.has(file)) continue;
      const code = codeOf(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8'));
      if (!isHelperWriter(code) && !isInlineThisRepoMainPush(code)) continue;
      if (!hasCredentialLoad(code)) missing.push(file);
    }
    expect(missing, `missing load-rc-env.mjs or mint-app-token.mjs:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('inline git push writers also clear checkout extraheader via the configure helper (or equivalent)', () => {
    const missing: string[] = [];
    for (const file of files) {
      if (DISABLED_CRAWLER.test(file) || FOREIGN_REMOTE.has(file)) continue;
      const code = codeOf(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8'));
      if (!isInlineThisRepoMainPush(code)) continue;
      const usesPushHelper =
        code.includes('git-push-with-retry.sh') || code.includes('git-commit-data.sh');
      if (usesPushHelper) continue;
      if (!hasInlineConfigure(code)) missing.push(file);
    }
    expect(
      missing,
      `inline main push without configure-main-push-auth.sh / extraheader unset:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('does not treat GITHUB_TOKEN as a push identity in the shared helpers', () => {
    const commit = readFileSync(resolve(import.meta.dirname, '../scripts/lib/git-commit-data.sh'), 'utf8');
    const retry = readFileSync(resolve(import.meta.dirname, '../scripts/lib/git-push-with-retry.sh'), 'utf8');
    const configure = readFileSync(
      resolve(import.meta.dirname, '../scripts/lib/configure-main-push-auth.sh'),
      'utf8',
    );
    expect(commit).toContain('configure-main-push-auth.sh');
    expect(retry).toContain('configure-main-push-auth.sh');
    expect(configure).toContain('GITHUB_PAT:-${APP_TOKEN:-}');
    expect(configure).not.toMatch(/GITHUB_TOKEN:-\}/);
    expect(configure).toContain('--unset-all http.https://github.com/.extraheader');
  });
});
