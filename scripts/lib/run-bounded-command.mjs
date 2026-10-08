#!/usr/bin/env node
// Runs one command with a wall-clock cap.
//
//   node scripts/lib/run-bounded-command.mjs --timeout-seconds 180 \
//     --label "git push of the stable branch" -- git push <url> HEAD:<branch>
//
// The command inherits stdin/stdout/stderr and its exit status is passed
// through. Past the cap the whole process group is stopped (SIGTERM, then
// SIGKILL one second later), an `::error::` line names the label and the cap,
// and the status is 124, like timeout(1). A signal sent to this wrapper is passed
// on the same way. After a stop the wrapper answers only once the group is gone,
// or once the SIGKILL has gone out: a helper that ignored the first signal does
// not outlive the status its caller acts on. The label is what the log shows:
// never put a URL with credentials in it.
//
// Why not timeout(1): the publisher scripts are exercised on macOS too, where
// coreutils is not installed, and a network command that Git runs through
// helpers (remote-https, pack-objects) only stops if its group is signalled.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

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
    if (!value) usage(`${arg} requires a value.`);
    if (arg === '--timeout-seconds') timeoutSeconds = value;
    else label = value;
    index += 1;
  } else if (arg === '--') {
    command = process.argv.slice(index + 1);
    break;
  } else {
    usage(`Unknown argument: ${arg}`);
  }
}

// setTimeout takes a signed 32-bit number of milliseconds; a larger delay fires at once.
const MAX_TIMEOUT_SECONDS = 2_147_483;
if (!/^[1-9]\d*$/u.test(timeoutSeconds) || Number(timeoutSeconds) > MAX_TIMEOUT_SECONDS) {
  usage(`--timeout-seconds must be a positive integer no larger than ${MAX_TIMEOUT_SECONDS}.`);
}
if (!label) usage('--label requires a value.');
if (command.length === 0) usage('the command to run is missing.');

const timeoutMs = Number(timeoutSeconds) * 1000;
const child = spawn(command[0], command.slice(1), {
  // Its own process group, so the helpers it starts stop with it.
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});

let settled = false;
let timedOut = false;
let stopRequested = false;
let forceSent = false;
let closedStatus;
let timer;
let forceTimer;
let groupPoll;

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
  if (groupPoll) clearInterval(groupPoll);
  process.exitCode = status;
}

// Whether nothing is left of the command's process group. Signal 0 delivers
// nothing; it only reports whether a member is still there.
function groupIsGone() {
  if (!child.pid || process.platform === 'win32') return true;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function forceStop() {
  forceSent = true;
  terminate('SIGKILL');
  // The command had already gone and only its helpers were being waited for.
  if (closedStatus !== undefined) finish(closedStatus);
}

// The group gets the signal now and, if anything of it is still there one
// second later, SIGKILL.
function stop(signal) {
  if (settled) return;
  stopRequested = true;
  terminate(signal);
  if (!forceTimer) forceTimer = setTimeout(forceStop, 1000);
}

// A cancelled job signals this wrapper, not the detached group: pass it on, or
// the command would outlive the step that started it. A command that ignores
// the signal is stopped for good one second later, like one past its cap.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal));
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
  stop('SIGTERM');
}, timeoutMs);

function exitStatus(status, signal) {
  if (timedOut) return 124;
  if (typeof status === 'number') return status;
  // Ended by a signal: the shell convention, 128 plus its number.
  return signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1;
}

child.once('close', (status, signal) => {
  const exit = exitStatus(status, signal);
  // The command is gone, but a helper it started may have ignored the signal
  // (Git pushes through remote-https and pack-objects). Answering now would
  // cancel the SIGKILL and let that helper finish the push after its caller
  // had moved on to the retry: the force timer settles the wrapper instead.
  if (stopRequested && !forceSent && !groupIsGone()) {
    closedStatus = exit;
    clearTimeout(timer);
    // Helpers that did stop are reaped within moments: do not make every
    // timeout wait out the full second for them.
    groupPoll = setInterval(() => {
      if (groupIsGone()) finish(exit);
    }, 50);
    return;
  }
  finish(exit);
});
