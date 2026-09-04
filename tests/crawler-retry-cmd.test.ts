import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/crawler-retry-cmd.sh');

function runWith({
  command = ['npm', 'ci'],
  failTimes = 0,
  attempts = 3,
}: {
  command?: string[];
  failTimes?: number;
  attempts?: number;
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-retry-cmd-'));
  const counter = path.join(tmp, 'calls');
  const argsLog = path.join(tmp, 'args');
  const stub = path.join(tmp, command[0] || 'missing-command');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
n=0
[ -f "${counter}" ] && n=$(cat "${counter}")
n=$((n + 1))
printf '%s\n' "$n" > "${counter}"
printf '<%s>\n' "$@" >> "${argsLog}"
if [ "$n" -le ${failTimes} ]; then exit 1; fi
`);
  fs.chmodSync(stub, 0o755);

  try {
    const result = spawnSync('bash', [SCRIPT, ...command], {
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        CRAWLER_RETRY_CMD_ATTEMPTS: String(attempts),
        CRAWLER_RETRY_CMD_BACKOFF: '0',
      },
      encoding: 'utf8',
    });
    const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim()) : 0;
    const argLines = fs.existsSync(argsLog)
      ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean)
      : [];
    return { ...result, calls, argLines };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('crawler-retry-cmd.sh', () => {
  it('esegue una sola volta un comando riuscito', () => {
    const result = runWith();
    expect(result.status).toBe(0);
    expect(result.calls).toBe(1);
  });

  it('ritenta un errore transitorio e poi riesce', () => {
    const result = runWith({ failTimes: 1 });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(2);
  });

  it('fallisce dopo avere esaurito i tentativi', () => {
    const result = runWith({ failTimes: 99 });
    expect(result.status).toBe(1);
    expect(result.calls).toBe(3);
  });

  it('inoltra esattamente argv a npm e Playwright', () => {
    const npm = runWith({ command: ['npm', 'ci', '--ignore-scripts'] });
    expect(npm.status).toBe(0);
    expect(npm.argLines).toEqual(['<ci>', '<--ignore-scripts>']);

    const playwright = runWith({
      command: ['npx', 'playwright', 'install', '--with-deps', 'chromium'],
    });
    expect(playwright.status).toBe(0);
    expect(playwright.argLines).toEqual([
      '<playwright>',
      '<install>',
      '<--with-deps>',
      '<chromium>',
    ]);
  });

  it('senza comando fallisce loud con exit 2', () => {
    const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('senza comando');
  });

  it('rifiuta un comando non autorizzato', () => {
    const result = spawnSync('bash', [SCRIPT, 'node', '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('non autorizzato');
  });
});
