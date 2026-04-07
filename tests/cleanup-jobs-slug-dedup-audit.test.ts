import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-jobs.mjs');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-jobs-test-'));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCleanup(slicePath: string, expiredDir: string): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_SKIP_URL_VALIDATION: '1',
        JOBS_EXPIRED_SLICES_DIR: expiredDir,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

describe('cleanup-jobs slice slug dedup audit logging', () => {
  it('logs a clear count line listing within-slice slug collisions', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'test-crawler.json');

    // 3 jobs share slug "engineer-lugano"; 1 unique. Newer wins.
    // Use a unique crawlerKey per test run so the expired/by-crawler/ slice
    // path written by archiveExpiredJobsPerCrawler doesn't collide with other
    // tests or the real dataset.
    const crawlerKey = `test-crawler-audit-${Date.now()}`;
    const slice = {
      crawlerKey,
      jobs: [
        {
          id: 'job-1-old',
          slug: 'engineer-lugano',
          // Empty url → URL validation returns valid:true with no network call
          url: '',
          title: 'Engineer Lugano (older)',
          company: 'TestCo',
          location: 'Lugano',
          crawledAt: '2026-04-01T00:00:00.000Z',
        },
        {
          id: 'job-2-newest',
          slug: 'engineer-lugano',
          url: '',
          title: 'Engineer Lugano (newest)',
          company: 'TestCo',
          location: 'Lugano',
          crawledAt: '2026-04-05T00:00:00.000Z',
        },
        {
          id: 'job-3-mid',
          slug: 'engineer-lugano',
          url: '',
          title: 'Engineer Lugano (middle)',
          company: 'TestCo',
          location: 'Lugano',
          crawledAt: '2026-04-03T00:00:00.000Z',
        },
        {
          id: 'job-4-unique',
          slug: 'designer-bellinzona',
          url: '',
          title: 'Designer Bellinzona',
          company: 'TestCo',
          location: 'Bellinzona',
          crawledAt: '2026-04-04T00:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(slicePath, JSON.stringify(slice, null, 2), 'utf-8');

    const expiredDir = path.join(dir, 'expired');
    const result = await runCleanup(slicePath, expiredDir);
    const output = result.stdout + result.stderr;

    expect(result.code, output).toBe(0);
    // Audit log line: a clear summary count. The architectural fix renamed
    // "Removed" to "Archived" because losers are now preserved in expired/.
    expect(output).toContain('Archived 2 within-slice duplicate-slug jobs from slice');

    // Resulting slice has exactly 2 jobs (1 unique + 1 winner)
    const parsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const keptJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : parsed;
    expect(keptJobs.length).toBe(2);
    const slugs = keptJobs.map((j: { slug: string }) => j.slug).sort();
    expect(slugs).toEqual(['designer-bellinzona', 'engineer-lugano']);
    // The newest job wins
    const winner = keptJobs.find((j: { slug: string }) => j.slug === 'engineer-lugano');
    expect(winner.id).toBe('job-2-newest');
  }, 30000);
});
