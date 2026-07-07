/**
 * Guards the cross-process advisory lock added to scripts/lib/crawler-template.mjs
 * (acquireJobsJsonLock/releaseJobsJsonLock) that serializes read-modify-write
 * access to the shared data/jobs.json. Post-#3701, ~25 dedicated crawlers run
 * concurrently as sibling `background: true` steps in ONE job (one
 * filesystem) — without this lock, Step 3's "read snapshot, filter, write"
 * cycle is a classic lost-update race: whichever sibling's write lands last
 * wins, silently dropping every other concurrently-running sibling's jobs
 * (root cause of "No X jobs found after crawl" on crawlers whose own merge
 * actually succeeded).
 *
 * These tests spawn REAL child processes (not just interleaved JS promises
 * in one thread) because the actual race is an OS-level filesystem race
 * between separate `node` processes — single-threaded interleaving inside
 * one vitest worker cannot reproduce it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { acquireJobsJsonLock, releaseJobsJsonLock } from '../scripts/lib/crawler-template.mjs';

const CRAWLER_TEMPLATE_URL = pathToFileURL(
  path.join(__dirname, '../scripts/lib/crawler-template.mjs'),
).href;

let tmpDir: string;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-json-lock-test-'));
  return tmpDir;
}

function runWorker(targetPath: string, counterPath: string, iterations: number): Promise<number> {
  const workerSrc = [
    `import { acquireJobsJsonLock, releaseJobsJsonLock } from ${JSON.stringify(CRAWLER_TEMPLATE_URL)};`,
    `import fs from 'node:fs';`,
    `const target = ${JSON.stringify(targetPath)};`,
    `const counterPath = ${JSON.stringify(counterPath)};`,
    `for (let i = 0; i < ${iterations}; i++) {`,
    `  acquireJobsJsonLock(target);`,
    `  try {`,
    `    const data = JSON.parse(fs.readFileSync(counterPath, 'utf8'));`,
    `    const before = data.count;`,
    // Artificially widen the critical section so a real lost-update race
    // would reliably manifest if the lock did nothing.
    `    await new Promise((r) => setTimeout(r, 3));`,
    `    data.count = before + 1;`,
    `    fs.writeFileSync(counterPath, JSON.stringify(data));`,
    `  } finally {`,
    `    releaseJobsJsonLock(target);`,
    `  }`,
    `}`,
  ].join('\n');

  const workerPath = path.join(tmpDir, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(workerPath, workerSrc);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

describe('acquireJobsJsonLock / releaseJobsJsonLock', () => {
  it('serializes concurrent read-modify-write cycles across real child processes — no lost updates', async () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'jobs.json');
    fs.writeFileSync(targetPath, '[]\n');
    const counterPath = path.join(dir, 'counter.json');
    fs.writeFileSync(counterPath, JSON.stringify({ count: 0 }));

    const WORKERS = 4;
    const ITERATIONS_PER_WORKER = 10;
    const exitCodes = await Promise.all(
      Array.from({ length: WORKERS }, () => runWorker(targetPath, counterPath, ITERATIONS_PER_WORKER)),
    );

    expect(exitCodes.every((code) => code === 0), 'every worker process must exit cleanly').toBe(true);

    const final = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    // Without mutual exclusion, concurrent read-before-write interleaving
    // across processes would drop increments (final count < expected).
    expect(final.count).toBe(WORKERS * ITERATIONS_PER_WORKER);
  }, 20_000);

  it('force-releases a stale lock (dead sibling) instead of deadlocking the group', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'jobs.json');
    fs.writeFileSync(targetPath, '[]\n');

    const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('frontaliere-jobs-json-')));
    // Simulate a sibling that crashed while holding the lock: acquire it and
    // never release.
    acquireJobsJsonLock(targetPath);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('frontaliere-jobs-json-'));
    const lockName = after.find((f) => !before.has(f));
    expect(lockName, 'lock file must have been created under os.tmpdir()').toBeTruthy();
    const lockPath = path.join(os.tmpdir(), lockName!);

    // Backdate the lock file's mtime past the staleness threshold (30s).
    const staleTime = (Date.now() - 40_000) / 1000;
    fs.utimesSync(lockPath, staleTime, staleTime);

    const start = Date.now();
    // A second "acquire" call (standing in for a fresh sibling) must detect
    // staleness and force-break the lock quickly, not wait the full 60s
    // hard-deadline.
    acquireJobsJsonLock(targetPath);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);

    releaseJobsJsonLock(targetPath);
  });
});
