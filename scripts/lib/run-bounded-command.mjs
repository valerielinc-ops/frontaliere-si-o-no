#!/usr/bin/env node

import { spawn } from 'node:child_process';

function usage(message) {
  if (message) process.stderr.write(`::error::${message}\n`);
  process.stderr.write(
    'Usage: run-bounded-command.mjs --timeout-seconds <seconds> --label <label> -- <command> [args...]\n',
  );
  process.exit(2);
}

let timeoutSeconds = '';
let label = '';
let command = [];

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--timeout-seconds' || arg === '--label') {
    const value = process.argv[index + 1];
    if (!value) usage(`${arg} richiede un valore.`);
    if (arg === '--timeout-seconds') timeoutSeconds = value;
    else label = value;
    index += 1;
  } else if (arg === '--') {
    command = process.argv.slice(index + 1);
    break;
  } else {
    usage(`Argomento sconosciuto: ${arg}`);
  }
}

if (!/^[1-9]\d*$/u.test(timeoutSeconds)) usage('--timeout-seconds deve essere un intero positivo.');
if (!label) usage('--label richiede un valore.');
if (command.length === 0) usage('manca il comando da eseguire.');

const timeoutMs = Number(timeoutSeconds) * 1000;
const child = spawn(command[0], command.slice(1), {
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});

let settled = false;
let timedOut = false;
let timer;
let forceTimer;

function terminate(signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and the group kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close event will still settle the wrapper if the child exited.
  }
}

function finish(status) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  process.exitCode = status;
}

child.once('error', (error) => {
  if (settled) return;
  process.stderr.write(`::error::${label} could not start: ${error.message}\n`);
  finish(127);
});

timer = setTimeout(() => {
  if (settled) return;
  timedOut = true;
  process.stderr.write(`::error::${label} timed out after ${timeoutSeconds} second${timeoutSeconds === '1' ? '' : 's'}\n`);
  terminate('SIGTERM');
  forceTimer = setTimeout(() => terminate('SIGKILL'), 1000);
}, timeoutMs);

child.once('close', (status, signal) => {
  if (timedOut) {
    finish(124);
    return;
  }
  if (typeof status === 'number') {
    finish(status);
    return;
  }
  finish(signal === 'SIGTERM' ? 143 : 1);
});
