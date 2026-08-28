/**
 * Every workflow that pushes THIS repo's `main` must have a ruleset-bypass
 * credential path *before* the push, not merely somewhere later in the file.
 * The ambient Actions GITHUB_TOKEN is rejected with GH013.
 *
 * Credential load = load-rc-env.mjs (GITHUB_PAT) and/or mint-app-token.mjs
 * (APP_TOKEN). Shared helpers fail-closed on those env vars; inline `git push`
 * writers must also call configure-main-push-auth.sh (or the equivalent
 * extraheader-unset + x-access-token rewrite) before the push line.
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

export type PushSite = { line: number; kind: 'helper' | 'inline'; text: string };

function isCommentOrEcho(raw: string): boolean {
  const line = raw.trim();
  return /^\s*#/.test(raw) || /^(echo|printf)\b/.test(line);
}

/** Bare `git push` / `if git push;` — default tracking branch of the checkout. */
function isDefaultTrackingPush(line: string): boolean {
  if (!/\bgit push\b/.test(line)) return false;
  if (/\bgit push\s+-/.test(line)) return false; // git push -u / --force / --no-verify …
  if (/\bgit push\s+"/.test(line)) return false; // git push "$REMOTE_URL"
  if (/\bgit push\s+\$/.test(line)) return false;
  if (/\bgit push\s+\S+/.test(line)) return false; // git push origin …
  return /if\s+git push\s*;/.test(line) || /\bgit push\s*(;|then|&&|$)/.test(line);
}

function isThisRepoMainRefPush(line: string): boolean {
  if (/TARGET_BRANCH|head\.ref|fix\/issue-/.test(line)) return false;
  if (/HEAD:\$\{/.test(line) && !/HEAD:main/.test(line)) return false;
  return (
    /HEAD:main/.test(line) ||
    /\borigin main\b/.test(line) ||
    /git push origin HEAD:main/.test(line) ||
    /&& git push\b/.test(line) ||
    /git push &&/.test(line) ||
    isDefaultTrackingPush(line)
  );
}

export function thisRepoMainPushes(src: string): PushSite[] {
  const lines = src.split('\n');
  const out: PushSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (isCommentOrEcho(raw)) continue;
    if (line.includes('git-push-with-retry.sh') || line.includes('git-commit-data.sh')) {
      out.push({ line: i, kind: 'helper', text: line });
      continue;
    }
    if (!/\bgit push\b/.test(line)) continue;
    if (isThisRepoMainRefPush(line)) {
      out.push({ line: i, kind: 'inline', text: line });
    }
  }
  return out;
}

function codeBefore(src: string, line: number): string {
  return src
    .split('\n')
    .slice(0, line)
    .filter((raw) => !isCommentOrEcho(raw))
    .join('\n');
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

export function missingAuthBeforePushes(
  src: string,
): Array<{ line: number; kind: PushSite['kind']; reason: string; text: string }> {
  const missing: Array<{ line: number; kind: PushSite['kind']; reason: string; text: string }> = [];
  for (const site of thisRepoMainPushes(src)) {
    const before = codeBefore(src, site.line);
    if (!hasCredentialLoad(before)) {
      missing.push({
        line: site.line,
        kind: site.kind,
        reason: 'load-rc-env.mjs / mint-app-token.mjs must appear BEFORE this push',
        text: site.text,
      });
      continue;
    }
    if (site.kind === 'inline' && !hasInlineConfigure(before)) {
      missing.push({
        line: site.line,
        kind: site.kind,
        reason: 'configure-main-push-auth.sh (or extraheader unset + x-access-token) must appear BEFORE this push',
        text: site.text,
      });
    }
  }
  return missing;
}

describe('this-repo main writers have a ruleset-bypass credential path before the push', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  it('flags a bare git push whose mint/configure is only later in the file (the prospector-loop gap)', () => {
    const yml = `
      - name: Commit the queue
        run: |
          git commit -m 'queue'
          for attempt in 1 2 3; do
            if git push; then
              exit 0
            fi
          done
      - name: Mint App token
        run: node scripts/ci/mint-app-token.mjs
      - name: Rewrite remote
        run: |
          git config --unset-all "http.https://github.com/.extraheader" || true
          git remote set-url origin "https://x-access-token:\${APP_TOKEN}@github.com/\${GITHUB_REPOSITORY}.git"
    `;
    const missing = missingAuthBeforePushes(yml);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((m) => /if git push;/.test(m.text))).toBe(true);
  });

  it('every this-repo main push has load/mint (and configure, for inline) on an earlier line', () => {
    const missing: string[] = [];
    for (const file of files) {
      if (DISABLED_CRAWLER.test(file) || FOREIGN_REMOTE.has(file)) continue;
      const src = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8');
      for (const gap of missingAuthBeforePushes(src)) {
        missing.push(`${file}:${gap.line + 1}: ${gap.reason} — ${gap.text}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('prospector-loop.yml loads RC and configures auth before the bare git push, not only before the promotion PR', () => {
    const src = readFileSync(resolve(WORKFLOWS_DIR, 'prospector-loop.yml'), 'utf8');
    const pushLine = src.split('\n').findIndex((l) => /if git push;/.test(l));
    expect(pushLine).toBeGreaterThan(0);
    const before = codeBefore(src, pushLine);
    expect(before).toContain('load-rc-env.mjs');
    expect(before).toContain('configure-main-push-auth.sh');
    const mintLine = src.split('\n').findIndex((l) => l.includes('mint-app-token.mjs'));
    expect(mintLine).toBeGreaterThan(pushLine);
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
