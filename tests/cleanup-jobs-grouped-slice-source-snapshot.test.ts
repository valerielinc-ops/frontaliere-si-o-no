import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-jobs.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-grouped-slice-'));
  tempDirs.push(dir);
  return dir;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP address');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runCleanup(slicePath: string, expiredDir: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_HOUSEKEEPING_SCOPE: 'bucherer',
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_SKIP_URL_VALIDATION: '',
        JOBS_STALE_DAYS: '60',
        JOBS_EXPIRED_SLICES_DIR: expiredDir,
        GITHUB_SHA: 'test-housekeeping-sha',
        GITHUB_RUN_ID: 'test-housekeeping-run',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('grouped crawler slice housekeeping', () => {
  it('keeps a source-backed snapshot when the generic URL probe would return 404', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);

    try {
      const dir = makeTempDir();
      const slicePath = path.join(dir, 'bucherer.json');
      const slice = {
        crawlerKey: 'bucherer',
        jobs: [{
          id: 'bucherer-test-855',
          slug: 'sales-advisor-lugano-bucherer',
          company: 'Bucherer',
          title: 'Sales Advisor',
          location: 'Lugano',
          url: `http://127.0.0.1:${port}/jobs/855`,
          crawledAt: daysAgo(1),
          firstSeenAt: daysAgo(1),
        }],
      };
      fs.writeFileSync(slicePath, JSON.stringify(slice, null, 2), 'utf8');

      const result = await runCleanup(slicePath, path.join(dir, 'expired'));
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Slice URL validation skipped (grouped crawler slice');
      expect(result.output).toContain('Slice clean — no jobs removed.');
      expect(requests).toBe(0);

      const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
      expect(written.jobs).toHaveLength(1);
      expect(written.jobs[0].id).toBe('bucherer-test-855');
    } finally {
      await close(server);
    }
  });
});
