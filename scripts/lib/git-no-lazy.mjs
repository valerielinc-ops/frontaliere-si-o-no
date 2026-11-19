#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { isInvokedDirectly } from './is-invoked-directly.mjs';

const MIN_NO_LAZY_FETCH_VERSION = Object.freeze([2, 44]);

function supportsNoLazyFetch(versionOutput) {
  const match = /^git version\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(String(versionOutput || ''));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_NO_LAZY_FETCH_VERSION[0]
    || (major === MIN_NO_LAZY_FETCH_VERSION[0] && minor >= MIN_NO_LAZY_FETCH_VERSION[1]);
}

export function createNoLazyGitInvocation({
  executable = 'git',
  env = process.env,
  spawn = spawnSync,
} = {}) {
  let available;

  return (args = []) => {
    if (available === undefined) {
      try {
        const result = spawn(executable, ['--version'], {
          encoding: 'utf8',
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        available = result.status === 0 && supportsNoLazyFetch(result.stdout);
      } catch {
        available = false;
      }
    }

    if (!available) return null;
    return {
      args: ['--no-lazy-fetch', ...args],
      env: { GIT_NO_LAZY_FETCH: '1' },
    };
  };
}

const invocationsByPath = new Map();

export function noLazyGitInvocation(args = [], env = process.env) {
  const path = env?.PATH ?? process.env.PATH ?? '';
  if (!invocationsByPath.has(path)) {
    invocationsByPath.set(path, createNoLazyGitInvocation({ env: { ...process.env, ...env } }));
  }
  return invocationsByPath.get(path)(args);
}

if (isInvokedDirectly(import.meta.url)) {
  const [mode, executable = 'git'] = process.argv.slice(2);
  if (mode !== '--supports') {
    console.error('usage: node scripts/lib/git-no-lazy.mjs --supports [git-executable]');
    process.exitCode = 2;
  } else if (!createNoLazyGitInvocation({ executable })([])) {
    process.exitCode = 1;
  }
}
