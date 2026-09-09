#!/usr/bin/env node
/** Scheduler entry point kept separate from the importer so CI can invoke the
 * same guarded operation locally and from the daily workflow. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'import-pharmacy-duties-ticino.mjs');
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
