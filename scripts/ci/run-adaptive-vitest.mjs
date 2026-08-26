#!/usr/bin/env node

/**
 * Runs one Vitest group while sharing the runner CPUs dynamically with the
 * other group. Vitest fixes maxWorkers when the process starts, so a static
 * 50% leaves capacity unused as soon as its sibling exits. Linux taskset lets
 * the scheduler resize the process affinity without restarting the suite.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const prefix = `--${name}=`;
  const index = args.findIndex((arg) => arg.startsWith(prefix));
  if (index < 0) throw new Error(`missing required argument --${name}=...`);
  const value = args[index].slice(prefix.length);
  args.splice(index, 1);
  return value;
};

const group = valueOf('group');
const outputFile = valueOf('output');
if (!['independent', 'dependent'].includes(group)) throw new Error(`invalid group: ${group}`);

const runId = process.env.GITHUB_RUN_ID || `local-${process.ppid}`;
const stateDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `frontaliere-vitest-${runId}`);
mkdirSync(stateDir, { recursive: true });
const marker = path.join(stateDir, `${group}.pid`);

const taskset = (() => {
  try {
    execFileSync('taskset', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const cpuCount = Math.max(1, Number(process.env.VITEST_CPU_COUNT || os.availableParallelism()));
const cpuList = Array.from({ length: cpuCount }, (_, index) => index);

function liveGroups() {
  return readdirSync(stateDir)
    .filter((name) => name.endsWith('.pid'))
    .flatMap((name) => {
      const file = path.join(stateDir, name);
      try {
        const pid = Number(readFileSync(file, 'utf8'));
        process.kill(pid, 0);
        return [{ group: name.slice(0, -4), pid, file }];
      } catch {
        try {
          unlinkSync(file);
        } catch {}
        return [];
      }
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

function affinityFor(index, count) {
  if (count <= 1) return cpuList.join(',');
  const split = Math.max(1, Math.floor(cpuList.length / count));
  const start = Math.min(index * split, cpuList.length - 1);
  const end = index === count - 1 ? cpuList.length - 1 : Math.max(start, (index + 1) * split - 1);
  return cpuList.slice(start, end + 1).join(',');
}

function rebalance() {
  const groups = liveGroups();
  if (!taskset) return;
  for (const [index, entry] of groups.entries()) {
    const affinity = affinityFor(index, groups.length);
    try {
      // -a applies the mask to the process and all its existing worker
      // threads; newly created threads inherit the process mask.
      execFileSync('taskset', ['-ap', '-c', affinity, String(entry.pid)], { stdio: 'ignore' });
    } catch {
      // A process can disappear between liveGroups() and taskset(). The next
      // poll will clean its marker and rebalance the survivor.
    }
  }
}

const vitest = path.resolve('node_modules/.bin/vitest');
if (!existsSync(vitest)) throw new Error(`Vitest binary not found: ${vitest}`);

const child = spawn(vitest, ['run', '--maxWorkers=100%', ...args], {
  stdio: 'inherit',
  env: { ...process.env, VITEST_MAX_WORKERS: '100%' },
});
writeFileSync(marker, String(child.pid));
rebalance();

const timer = setInterval(rebalance, 1000);
const cleanup = () => {
  clearInterval(timer);
  try {
    unlinkSync(marker);
  } catch {}
  rebalance();
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  cleanup();
  console.error(error);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
