#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

function runGit(args, { cwd, stdio = 'ignore' } = {}) {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio });
  return output ? output.trim() : '';
}

/**
 * Appends ephemeral Git config entries without overwriting entries supplied by
 * the caller through GIT_CONFIG_COUNT and its indexed key/value variables.
 */
export function appendGitConfigEnvironment(baseEnv, entries) {
  const parsedCount = Number.parseInt(baseEnv.GIT_CONFIG_COUNT || '0', 10);
  const existingCount = Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  const env = { ...baseEnv };
  entries.forEach(({ key, value }, offset) => {
    const index = existingCount + offset;
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(existingCount + entries.length);
  return env;
}

function isRemoteName(value) {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function isRemoteLocation(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|[^/\\\s@]+@[^/\\\s:]+:)/iu.test(value);
}

export function resolveScratchRemote({ cwd, remote }) {
  let location = remote;
  if (isRemoteName(remote)) {
    try {
      location = runGit(['-C', cwd, 'remote', 'get-url', remote], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      location = remote;
    }
  }
  if (isAbsolute(location) || isRemoteLocation(location)) return location;
  return resolve(cwd, location);
}

/**
 * A filtered fetch by credential-bearing URL asks Git to remember that URL as
 * a promisor remote. Keep the URL written by Git credential-free and pass its
 * Basic header ephemerally to the child instead.
 */
export function checkoutFetchTarget({ cwd, remote }) {
  const location = resolveScratchRemote({ cwd, remote });
  let url;
  try {
    url = new URL(location);
  } catch {
    return { remote, env: process.env };
  }
  if (!['http:', 'https:'].includes(url.protocol) || (!url.username && !url.password)) {
    return { remote, env: process.env };
  }

  const authorization = `AUTHORIZATION: basic ${Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString('base64')}`;
  const credentiallessUrl = new URL(url);
  credentiallessUrl.username = '';
  credentiallessUrl.password = '';
  const originKey = `http.${credentiallessUrl.origin}/.extraheader`;
  const existingHeaders = checkoutHttpExtraHeaders(cwd);
  const resetHeaders = existingHeaders
    .filter(({ key }) => key.toLowerCase() === 'http.extraheader'
      || key.toLowerCase().startsWith(`http.${credentiallessUrl.origin.toLowerCase()}`))
    .map(({ key }) => ({ key, value: '' }));
  const env = appendGitConfigEnvironment(process.env, [
    ...resetHeaders,
    { key: originKey, value: authorization },
  ]);
  return { remote: credentiallessUrl.href, env };
}

export function checkoutHttpExtraHeaders(cwd) {
  try {
    const output = runGit(['-C', cwd, 'config', '--get-regexp', '^http(\\..*)?\\.extraheader$'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\n').map((line) => {
      const match = /^(\S+)\s(.*)$/u.exec(line);
      return match ? { key: match[1], value: match[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}
