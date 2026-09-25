#!/usr/bin/env node
/** Scheduler entry point kept separate from the importer so CI can invoke the
 * same guarded operation locally and from the daily workflow. */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'import-pharmacy-duties-ticino.mjs');

/**
 * Without the CI stage, a local invocation is an explicit read-only preview.
 * The importer remains the sole producer and still refuses an un-staged write.
 */
export function buildSyncArgs(argv = process.argv.slice(2), env = process.env) {
  const hasStage = typeof env.PHARMACY_DUTY_STAGE_DIR === 'string' && env.PHARMACY_DUTY_STAGE_DIR.trim() !== '';
  const preview = !hasStage && !argv.includes('--dry-run');
  return [script, ...(preview ? ['--dry-run'] : []), ...argv];
}

function run() {
  const child = spawn(process.execPath, buildSyncArgs(), { stdio: 'inherit', env: process.env });
  let spawnFailed = false;
  child.once('error', (error) => {
    spawnFailed = true;
    console.error('[sync-pharmacy-duties] failed to start importer:', error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (spawnFailed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) run();
