import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

async function runCleanup(
  slicePath: string,
  expiredDir: string,
  fetchPreloadPath: string,
  fetchMarkerPath: string,
  housekeepingScope = 'bucherer',
): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_HOUSEKEEPING_SCOPE: housekeepingScope,
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_SKIP_URL_VALIDATION: '',
        JOBS_STALE_DAYS: '60',
        JOBS_EXPIRED_SLICES_DIR: expiredDir,
        TEST_FETCH_MARKER: fetchMarkerPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(fetchPreloadPath).href}`.trim(),
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
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'bucherer.json');
    const fetchPreloadPath = path.join(dir, 'fetch-404.mjs');
    const fetchMarkerPath = path.join(dir, 'fetch-called');
    fs.writeFileSync(
      fetchPreloadPath,
      [
        "import fs from 'node:fs';",
        "globalThis.fetch = async () => {",
        "  fs.appendFileSync(process.env.TEST_FETCH_MARKER, 'called\\n');",
        "  return new Response('', { status: 404 });",
        '};',
      ].join('\n'),
      'utf8',
    );
    const slice = {
      crawlerKey: 'bucherer',
      jobs: [{
        id: 'bucherer-test-855',
        slug: 'sales-advisor-lugano-bucherer',
        company: 'Bucherer',
        title: 'Sales Advisor',
        location: 'Lugano',
        url: 'https://jobs.dayforcehcm.com/fr-FR/bucherer/CANDIDATEPORTAL/jobs/855',
        crawledAt: daysAgo(1),
        firstSeenAt: daysAgo(1),
      }],
    };
    fs.writeFileSync(slicePath, JSON.stringify(slice, null, 2), 'utf8');

    const result = await runCleanup(slicePath, path.join(dir, 'expired'), fetchPreloadPath, fetchMarkerPath);
    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(fetchMarkerPath)).toBe(false);

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    expect(written.jobs).toHaveLength(1);
    expect(written.jobs[0].id).toBe('bucherer-test-855');
  });

  it('keeps a fresh crawler observation when a generic probe returns a definitive 404', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'cippatrasporti.json');
    const fetchPreloadPath = path.join(dir, 'fetch-404.mjs');
    const fetchMarkerPath = path.join(dir, 'fetch-called');
    fs.writeFileSync(
      fetchPreloadPath,
      [
        "import fs from 'node:fs';",
        "globalThis.fetch = async () => {",
        "  fs.appendFileSync(process.env.TEST_FETCH_MARKER, 'called\\n');",
        "  return new Response('', { status: 404 });",
        '};',
      ].join('\n'),
      'utf8',
    );
    const slice = {
      crawlerKey: 'cippatrasporti',
      jobs: [{
        id: 'cippatrasporti-5dd16ddc181a',
        slug: 'ocean-freight-operations-specialist-fcl-project-cargo-cippatrasporti-ch',
        company: 'Cippà Trasporti SA',
        title: 'Ocean Freight Operations Specialist – FCL & Project Cargo',
        location: 'Chiasso',
        url: 'https://cippatrasporti.altamiraweb.com/annunci-lavoro/Ocean-Freight-Operations-Specialist-FCL-Project-Cargo-Trasporti-Chiasso-662670289.htm',
        crawledAt: daysAgo(1),
        firstSeenAt: daysAgo(80),
      }],
      assembledAt: daysAgo(1),
    };
    fs.writeFileSync(slicePath, JSON.stringify(slice, null, 2), 'utf8');

    const result = await runCleanup(
      slicePath,
      path.join(dir, 'expired'),
      fetchPreloadPath,
      fetchMarkerPath,
      '',
    );
    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(fetchMarkerPath, 'utf8')).toBe('called\n');

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    expect(written.jobs).toHaveLength(1);
    expect(written.jobs[0].id).toBe('cippatrasporti-5dd16ddc181a');
  });
});
