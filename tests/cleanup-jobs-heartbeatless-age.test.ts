/**
 * cleanup-jobs ages a record WITHOUT crawledAt by its last observation.
 *
 * Before: the age prune read `job.crawledAt ? … : 0` and skipped `ts === 0`,
 * so the 1.535 active slice records with no crawledAt (2026-11-10, Galenica,
 * PEMSA, confederazione-ticino, AXA, …) could never expire, and a vacancy
 * closed at the source stayed active. Now the last observation is the later of
 * `firstSeenAt` and — for a row its crawler still lists as active — the time
 * the slice was last written; the same JOBS_STALE_DAYS window applies, and a
 * pruned record goes through the expired archive (soft landing), never a bare
 * deletion.
 *
 * The slice write time keeps the transition safe: a crawler that wrote its
 * slice today without stamping (pre-fix runner) does not see 120-day-old
 * first sightings expire en masse before its next run stamps them.
 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-heartbeatless-'));
  tempDirs.push(dir);
  return dir;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function job(n: number, overrides: Record<string, unknown> = {}) {
  const slug = `assistente-di-farmacia-${n}-farmacia-osservata-lugano`;
  return {
    id: `farmacia-osservata-${n}`,
    slug,
    slugByLocale: { it: slug },
    company: 'Farmacia Osservata',
    title: `Assistente di farmacia ${n}`,
    location: 'Lugano',
    addressLocality: 'Lugano',
    postalCode: '6900',
    streetAddress: 'Via Nassa 1',
    url: `https://jobs.farmacia-osservata.invalid/job/81${n}`,
    description: 'Consulenza alla clientela, preparazione dei medicamenti e gestione delle scorte in farmacia.',
    sourceLang: 'it',
    titleByLocale: { it: `Assistente di farmacia ${n}` },
    descriptionByLocale: { it: 'Consulenza alla clientela, preparazione dei medicamenti e gestione delle scorte in farmacia.' },
    firstSeenAt: daysAgo(120),
    ...overrides,
  };
}

async function runSliceHousekeeping(slicePath: string, dir: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_SKIP_URL_VALIDATION: '1',
        JOBS_STALE_DAYS: '60',
        JOBS_EXPIRED_SLICES_DIR: path.join(dir, 'expired'),
        SLUG_REGISTRY_PATH_OVERRIDE: path.join(dir, 'slug-registry.json'),
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_HOUSEKEEPING_SCOPE: '',
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

function writeSlice(dir: string, assembledAt: string, jobs: object[]): string {
  const slicePath = path.join(dir, 'farmacia-osservata.json');
  fs.writeFileSync(path.join(dir, 'slug-registry.json'), '{}\n');
  fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey: 'farmacia-osservata', assembledAt, jobs }, null, 2));
  return slicePath;
}

const ids = (slicePath: string) =>
  JSON.parse(fs.readFileSync(slicePath, 'utf8')).jobs.map((entry: { id: string }) => entry.id).sort();

function archivedSlugs(dir: string): string[] {
  const archivePath = path.join(dir, 'expired', 'farmacia-osservata.json');
  if (!fs.existsSync(archivePath)) return [];
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const entries = Array.isArray(archive) ? archive : (archive.jobs ?? []);
  return entries.map((entry: { slug: string }) => entry.slug).sort();
}

describe('cleanup-jobs ages records without crawledAt by their last observation', () => {
  it('expires through the archive an active record whose slice was last written past the window', async () => {
    const dir = makeTempDir();
    const heartbeatless = job(1);
    const fresh = job(2, { crawledAt: daysAgo(1) });
    const slicePath = writeSlice(dir, daysAgo(70), [heartbeatless, fresh]);

    const { code, output } = await runSliceHousekeeping(slicePath, dir);
    expect(code, output).toBe(0);
    expect(output).toContain('Records without crawledAt');

    expect(ids(slicePath)).toEqual(['farmacia-osservata-2']);
    expect(archivedSlugs(dir)).toEqual([heartbeatless.slug]);
  });

  it('keeps an active record without crawledAt whose crawler wrote the slice recently (no bulk expiry)', async () => {
    const dir = makeTempDir();
    const slicePath = writeSlice(dir, daysAgo(0), [job(1), job(2)]);

    const { code, output } = await runSliceHousekeeping(slicePath, dir);
    expect(code, output).toBe(0);

    expect(ids(slicePath)).toEqual(['farmacia-osservata-1', 'farmacia-osservata-2']);
    expect(archivedSlugs(dir)).toEqual([]);
  });

  it('ages a grace record without crawledAt by its first sighting, not by the slice write that missed it', async () => {
    const dir = makeTempDir();
    const grace = job(1, { crawlerMissStreak: 1, firstSeenAt: daysAgo(90) });
    const slicePath = writeSlice(dir, daysAgo(0), [grace, job(2)]);

    const { code, output } = await runSliceHousekeeping(slicePath, dir);
    expect(code, output).toBe(0);

    expect(ids(slicePath)).toEqual(['farmacia-osservata-2']);
    expect(archivedSlugs(dir)).toEqual([grace.slug]);
  });
});
