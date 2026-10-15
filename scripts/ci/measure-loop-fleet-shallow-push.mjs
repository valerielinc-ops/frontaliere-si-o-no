#!/usr/bin/env node
/**
 * Reproducible local measurement for the durable ledger push.
 *
 * It creates two identical bare remotes and two identical depth-1 clones,
 * appends the same ledger record, then measures the bounded push with and
 * without --no-thin. It never contacts GitHub and removes the fixture before
 * returning. The JSON output is suitable for a PR body or a CI summary.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initSeed(root) {
  const work = join(root, 'seed-work');
  const remote = join(root, 'seed-remote.git');
  mkdirSync(work, { recursive: true });
  git(root, ['init', '--bare', remote]);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'shallow-push-measurement']);
  git(work, ['config', 'user.email', 'shallow-push-measurement@example.invalid']);
  const ledger = join(work, 'data', 'loop-fleet', 'ledger');
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'seed.jsonl'), '{"recordId":"seed"}\n');
  git(work, ['add', 'data/loop-fleet/ledger/seed.jsonl']);
  git(work, ['commit', '-m', 'seed ledger fixture'], {
    GIT_AUTHOR_DATE: '2026-10-07T12:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-07T12:00:00Z',
  });
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', 'origin', 'HEAD:refs/heads/main']);
  git(work, ['push', 'origin', 'HEAD:refs/heads/ledger/loop-fleet']);
  return remote;
}

function prepareClone(root, remote, label) {
  const clone = join(root, label);
  git(root, ['clone', '--depth=1', '--branch', 'ledger/loop-fleet', pathToFileURL(remote).href, clone]);
  const shallow = git(clone, ['rev-parse', '--is-shallow-repository']) === 'true';
  const ledgerFile = join(clone, 'data', 'loop-fleet', 'ledger', 'seed.jsonl');
  writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8') + '{"recordId":"append-' + label + '"}\n');
  git(clone, ['config', 'user.name', 'shallow-push-measurement']);
  git(clone, ['config', 'user.email', 'shallow-push-measurement@example.invalid']);
  git(clone, ['add', 'data/loop-fleet/ledger/seed.jsonl']);
  git(clone, ['commit', '-m', 'append ledger fixture'], {
    GIT_AUTHOR_DATE: '2026-10-07T12:01:00Z',
    GIT_COMMITTER_DATE: '2026-10-07T12:01:00Z',
  });
  return { clone, shallow };
}

function measurePush(clone, noThin) {
  const args = ['-c', 'pack.window=0', '-c', 'pack.threads=1', 'push'];
  if (noThin) args.push('--no-thin');
  args.push('origin', 'HEAD:refs/heads/ledger/loop-fleet');
  const started = performance.now();
  git(clone, args);
  return Number((performance.now() - started).toFixed(3));
}

export function measureLoopFleetShallowPush() {
  const root = mkdtempSync(join(tmpdir(), 'loop-fleet-shallow-push-'));
  try {
    const seedRemote = initSeed(root);
    const baselineRemote = join(root, 'baseline-remote.git');
    const noThinRemote = join(root, 'no-thin-remote.git');
    cpSync(seedRemote, baselineRemote, { recursive: true });
    cpSync(seedRemote, noThinRemote, { recursive: true });
    const baseline = prepareClone(root, baselineRemote, 'baseline');
    const noThin = prepareClone(root, noThinRemote, 'no-thin');
    return {
      fixture: 'same depth-1 ledger clone and append',
      shallow: baseline.shallow && noThin.shallow,
      baseline: {
        command: 'git -c pack.window=0 -c pack.threads=1 push origin HEAD:refs/heads/ledger/loop-fleet',
        milliseconds: measurePush(baseline.clone, false),
      },
      noThin: {
        command: 'git -c pack.window=0 -c pack.threads=1 push --no-thin origin HEAD:refs/heads/ledger/loop-fleet',
        milliseconds: measurePush(noThin.clone, true),
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    console.log(JSON.stringify(measureLoopFleetShallowPush()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
