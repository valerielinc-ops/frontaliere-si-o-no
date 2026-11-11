import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { waitForDetachedGate } from '../scripts/ci/wait-for-detached-gate.mjs';

function currentProcessGroupId(): number {
  const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  return Number(value);
}

it('refuses to signal the collector process group', async () => {
  const protectedPgid = currentProcessGroupId();
  await expect(waitForDetachedGate({
    pid: process.pid,
    pgid: protectedPgid,
    protectedPgid,
    initialWaitMs: 0,
  })).resolves.toEqual({
    action: 'unsafe',
    stopped: false,
    reason: 'refusing to signal the collector process group',
  });
});

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('detached gate fixture did not start');
}

it('terminates and waits for an overdue detached gate process tree', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'detached-gate-'));
  const readyFile = path.join(tempDir, 'ready');
  const childCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.on('SIGTERM', () => {});",
    "const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();",
    "fs.writeFileSync(process.env.READY_FILE, pgid);",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const gate = spawn(process.execPath, ['-e', childCode], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, READY_FILE: readyFile },
  });
  const gatePid = gate.pid;
  if (!gatePid) throw new Error('detached gate fixture did not publish a PID');
  const gateClosed = once(gate, 'close');

  try {
    const gatePgid = Number(await waitForFile(readyFile));
    expect(gatePgid).toBe(gatePid);
    const result = await waitForDetachedGate({
      pid: gatePid,
      pgid: gatePgid,
      protectedPgid: currentProcessGroupId(),
      initialWaitMs: 0,
      termGraceMs: 100,
      killWaitMs: 3_000,
      pollIntervalMs: 20,
    });

    expect(result).toEqual({ action: 'terminated', stopped: true, signal: 'SIGKILL' });
    await Promise.race([
      gateClosed,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('detached gate launcher remained alive')), 3_000);
        timer.unref();
      }),
    ]);
  } finally {
    try {
      process.kill(-gatePid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
