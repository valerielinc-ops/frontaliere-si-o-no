// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/dev/install-swiss-runner.sh');
const roots: string[] = [];

function renderPlist(gitVersion: string) {
  const home = mkdtempSync(join(tmpdir(), 'swiss-runner-plist-'));
  roots.push(home);
  const modernGitDir = join(home, '.local/git-2.56.0/bin');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(modernGitDir, { recursive: true });

  const fakeGit = join(modernGitDir, 'git');
  writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf \'git version %s\\n\' "$FAKE_GIT_VERSION"\n  exit 0\nfi\nexit 97\n');
  chmodSync(fakeGit, 0o755);

  const fakePlutil = join(home, 'plutil');
  writeFileSync(fakePlutil, '#!/bin/sh\n[ "$1" = "-lint" ] && [ -f "$2" ]\n');
  chmodSync(fakePlutil, 0o755);

  const serviceAccount = join(home, 'service-account-fixture.json');
  writeFileSync(serviceAccount, '{}\n');
  const env = {
    ...process.env,
    HOME: home,
    FAKE_GIT_VERSION: gitVersion,
    SWISS_RUNNER_SA: serviceAccount,
    SWISS_RUNNER_LOG_DIR: join(home, 'logs'),
    SWISS_RUNNER_SITE: ROOT,
    SWISS_RUNNER_PLUTIL: fakePlutil,
  };
  const plist = execFileSync('bash', [SCRIPT, 'print-plist'], { cwd: ROOT, encoding: 'utf8', env });
  const pathValue = /<key>PATH<\/key><string>([^<]*)<\/string>/u.exec(plist)?.[1];
  return { home, modernGitDir, pathValue };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('install-swiss-runner PATH', () => {
  it('mette lo shim utente per primo e Git >=2.44 prima dei binari di sistema', () => {
    const { home, modernGitDir, pathValue } = renderPlist('2.56.0');
    const nodeDir = dirname(process.execPath);

    expect(pathValue?.startsWith(`${home}/.local/bin:${modernGitDir}:${nodeDir}:`)).toBe(true);
    expect(pathValue?.indexOf(modernGitDir)).toBeLessThan(pathValue?.indexOf('/usr/bin') ?? -1);
    expect(pathValue).toContain('/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('non aggiunge il binario noto al PATH quando è sotto la soglia supportata', () => {
    const { home, modernGitDir, pathValue } = renderPlist('2.39.2 (Apple Git-143)');

    expect(pathValue?.startsWith(`${home}/.local/bin:`)).toBe(true);
    expect(pathValue).not.toContain(modernGitDir);
    expect(pathValue).toContain('/usr/bin:/bin');
  });
});
