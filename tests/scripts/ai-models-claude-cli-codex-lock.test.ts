import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
  __codexFallbackMarkerPathForTests,
  resetState,
} from '../../scripts/lib/ai-models.mjs';

function runClaimProcess(moduleUrl: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const source = `import { __claimCodexFallbackForTests } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(__claimCodexFallbackForTests()));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: env.RUNNER_TEMP,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claim child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`claim child returned invalid output: ${stdout} ${String(error)}`));
      }
    });
  });
}

describe('Claude CLI → Codex fallback atomic run lock', () => {
  let markerRoot = '';
  const savedRunnerEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    resetState();
    for (const key of ['RUNNER_TEMP', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
      if (savedRunnerEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedRunnerEnv[key];
    }
    if (markerRoot) fs.rmSync(markerRoot, { recursive: true, force: true });
    markerRoot = '';
  });

  it('allows exactly one claimant across concurrent Node processes', async () => {
    markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-lock-test-'));
    const runId = `lock-${process.pid}-${Date.now()}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8',
      RUNNER_TEMP: markerRoot,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: '7',
    };
    for (const key of ['RUNNER_TEMP', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) savedRunnerEnv[key] = process.env[key];
    process.env.RUNNER_TEMP = markerRoot;
    process.env.GITHUB_RUN_ID = runId;
    process.env.GITHUB_RUN_ATTEMPT = '7';
    const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'scripts/lib/ai-models.mjs')).href;

    const claims = await Promise.all([
      runClaimProcess(moduleUrl, env),
      runClaimProcess(moduleUrl, env),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    const markerPath = path.join(markerRoot, `claude-haiku-codex-fallback-${runId}-7.claimed`);
    expect(__codexFallbackMarkerPathForTests()).toBe(markerPath);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.statSync(markerPath).mode & 0o777).toBe(0o600);
  });
});
