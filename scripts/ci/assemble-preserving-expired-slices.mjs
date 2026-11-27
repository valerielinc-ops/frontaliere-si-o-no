#!/usr/bin/env node
/**
 * Run `assemble-jobs-dataset.mjs` in a workflow that later commits crawler
 * slices, without letting assembly change the tracked expired archive.
 *
 * Assembly rewrites `data/jobs/expired/by-crawler/` in place: ghost
 * reconciliation drops an archive record and moves its routes into the active
 * record of `data/jobs.json`, which is gitignored (and capped at
 * DEFAULT_PREV_SLUG_CAP). That is correct for a deploy tree, which publishes
 * data/jobs.json, and loses URLs when the slice is committed: commit
 * 1d69ad33b41 (2026-11-26). This wrapper keeps every assembled output and puts
 * the expired slices back byte for byte, whatever the exit status.
 *
 * Whatever the workflow changed in those slices before this step is kept.
 * Arguments are forwarded to the assembler unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const EXPIRED_SLICES_RELATIVE_DIR = path.join('data', 'jobs', 'expired', 'by-crawler');
const ASSEMBLER = fileURLToPath(new URL('../assemble-jobs-dataset.mjs', import.meta.url));

const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

function restoreDirectory(backupDir, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const original = new Set(listFiles(backupDir));
  let restored = 0;
  for (const name of listFiles(dir)) {
    if (original.has(name)) continue;
    fs.rmSync(path.join(dir, name));
    restored += 1;
  }
  for (const name of original) {
    const source = path.join(backupDir, name);
    const target = path.join(dir, name);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(source))) continue;
    fs.copyFileSync(source, target);
    restored += 1;
  }
  return restored;
}

function runChild(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    // A cancelled job must still restore: forward the signal and keep waiting.
    const forward = (signal) => child.kill(signal);
    process.on('SIGTERM', forward);
    process.on('SIGINT', forward);
    const settle = () => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
    };
    child.once('error', (error) => { settle(); reject(error); });
    child.once('exit', (code) => { settle(); resolve(code ?? 1); });
  });
}

export async function runPreservingExpiredSlices({
  command = process.execPath,
  args = [ASSEMBLER],
  cwd = process.cwd(),
} = {}) {
  const dir = path.join(cwd, EXPIRED_SLICES_RELATIVE_DIR);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-slices-backup-'));
  try {
    // An unreadable directory throws here, before anything can be rewritten.
    for (const name of listFiles(dir)) {
      fs.copyFileSync(path.join(dir, name), path.join(backupDir, name), fs.constants.COPYFILE_FICLONE);
    }
    let status;
    try {
      status = await runChild(command, args, cwd);
    } finally {
      const restored = restoreDirectory(backupDir, dir);
      console.log(`🛟 Expired slices: ${restored} file(s) rewritten by assembly put back as they were.`);
    }
    return status;
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = await runPreservingExpiredSlices({ args: [ASSEMBLER, ...process.argv.slice(2)] });
}
