import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-jobs-archive-test-'));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CleanupSliceJob {
  id: string;
  slug: string;
  url: string;
  title: string;
  company: string;
  location: string;
  crawledAt: string;
  description?: string;
  postalCode?: string;
  streetAddress?: string;
  addressLocality?: string;
  applyUrl?: string;
}

interface ExpiredEntry {
  slug: string;
  title: string;
  company: string;
  previousSlugs?: string[];
  dedupArchive?: boolean;
  expiredAt: string;
}

async function runCleanupSlice(slicePath: string, expiredDir: string): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_SKIP_URL_VALIDATION: '1',
        JOBS_STALE_DAYS: '60',
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

async function runCleanupSliceWithUrlValidation(slicePath: string, expiredDir: string): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_SKIP_LOCALE_HARDENING: '1',
        JOBS_STALE_DAYS: '60',
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

function urlForId(id: string): string {
  // Map a string id to a stable numeric vacancy id so the URL is identifier-
  // extractable by extractJobIdentityFromUrl, which makes stableSlugHash
  // return a deterministic 6-char base36 hash. The mapping is content-based
  // (DJB2-like) so re-runs of the same id always produce the same URL.
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  const numericId = String(Math.abs(hash) || 1) + '0';
  return `https://example.test/jobs/${numericId}`;
}

function buildJob(overrides: Partial<CleanupSliceJob> & Pick<CleanupSliceJob, 'id' | 'slug' | 'title' | 'crawledAt'>): CleanupSliceJob {
  // URL with /jobs/{numericId} → extractJobIdentityFromUrl returns
  // `example.test|{id}` → fingerprint `id|...` → stableSlugHash returns a
  // deterministic 6-char base36 hash. Cleanup must run with
  // JOBS_SKIP_URL_VALIDATION=1 so no network IO occurs.
  return {
    url: urlForId(overrides.id),
    company: 'TestCo',
    location: 'Lugano',
    description: 'A long enough description for soft-landing pages, well over thirty characters.',
    postalCode: '6900',
    streetAddress: 'Via Test 1',
    addressLocality: 'Lugano',
    ...overrides,
  };
}

// Recency relative to "now" so fixtures never age past cleanup-jobs.mjs's
// 60-day stale-prune, which runs BEFORE slug-dedup. Absolute dates here were a
// time-bomb: once they crossed the 60-day window the older job was pruned as
// stale instead of archived as a dedup-loser, so the archive assertions went
// red on a pure calendar boundary (last green 2026-05-30, red 2026-06-01).
// Keep the relative ordering — the winner is the most recent crawl.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe('cleanup-jobs slice mode — archives within-slice slug-dedup losers', () => {
  it('keeps a job when the canonical URL is dead but applyUrl is live', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/apply') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>Application form</body></html>');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const dir = makeTempDir();
      const slicePath = path.join(dir, 'apply-url-fallback.json');
      const expiredDir = path.join(dir, 'expired');
      const crawlerKey = `apply-url-fallback-${Date.now()}`;
      const jobs: CleanupSliceJob[] = [
        buildJob({
          id: 'job-apply-url-001',
          slug: 'nurse-live-apply',
          title: 'Nurse With Live Apply URL',
          crawledAt: new Date().toISOString(),
          url: `${baseUrl}/dead-detail`,
          applyUrl: `${baseUrl}/apply`,
        }),
      ];

      fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

      const result = await runCleanupSliceWithUrlValidation(slicePath, expiredDir);
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(0);

      const sliceParsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
      const keptJobs: CleanupSliceJob[] = Array.isArray(sliceParsed?.jobs) ? sliceParsed.jobs : sliceParsed;
      expect(keptJobs).toHaveLength(1);
      expect(keptJobs[0].id).toBe('job-apply-url-001');
      expect(output).toContain('Slice clean');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('moves losers to expired/by-crawler with disambiguated slugs and previousSlugs[]', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'archive-slice-test.json');
    const expiredDir = path.join(dir, 'expired');
    const crawlerKey = `archive-slice-${Date.now()}`;

    // 3 jobs: 2 collide on slug "engineer-lugano" + 1 unique. Newer wins.
    const jobs: CleanupSliceJob[] = [
      buildJob({
        id: 'job-loser-001',
        slug: 'engineer-lugano',
        title: 'Engineer Lugano (older)',
        crawledAt: daysAgo(10),
      }),
      buildJob({
        id: 'job-winner-002',
        slug: 'engineer-lugano',
        title: 'Engineer Lugano (winner)',
        crawledAt: daysAgo(5),
      }),
      buildJob({
        id: 'job-unique-003',
        slug: 'designer-bellinzona',
        title: 'Designer Bellinzona',
        location: 'Bellinzona',
        addressLocality: 'Bellinzona',
        crawledAt: daysAgo(7),
      }),
    ];

    fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

    const result = await runCleanupSlice(slicePath, expiredDir);
    const output = result.stdout + result.stderr;
    expect(result.code, output).toBe(0);

    // Slice should have 2 jobs: the winner + the unique.
    const sliceParsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const keptJobs: CleanupSliceJob[] = Array.isArray(sliceParsed?.jobs) ? sliceParsed.jobs : sliceParsed;
    expect(keptJobs.length).toBe(2);
    const slugs = keptJobs.map((j) => j.slug).sort();
    expect(slugs).toEqual(['designer-bellinzona', 'engineer-lugano']);
    const winner = keptJobs.find((j) => j.slug === 'engineer-lugano');
    expect(winner?.id).toBe('job-winner-002');

    // Expired slice file should now contain the loser with a disambiguated slug.
    const expiredSlicePath = path.join(expiredDir, `${crawlerKey}.json`);
    expect(fs.existsSync(expiredSlicePath)).toBe(true);
    const expiredEntries: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));
    expect(Array.isArray(expiredEntries)).toBe(true);

    // Find the dedup-archived loser by its dedupArchive marker.
    const archivedLosers = expiredEntries.filter((e) => e.dedupArchive === true);
    expect(archivedLosers.length).toBe(1);

    const archived = archivedLosers[0];

    // The disambiguated slug must NOT equal the original colliding slug.
    expect(archived.slug).not.toBe('engineer-lugano');

    // The disambiguated slug must end with a hash-style suffix (6 alphanum chars).
    expect(archived.slug).toMatch(/-[a-z0-9]{6}$/);

    // The original (colliding) slug must be preserved in previousSlugs[]
    // so any indexed URL still resolves to a soft-landing page.
    expect(Array.isArray(archived.previousSlugs)).toBe(true);
    expect(archived.previousSlugs).toContain('engineer-lugano');

    // Title must be preserved (the older "loser" job's title).
    expect(archived.title).toBe('Engineer Lugano (older)');

    // The audit log message must reflect the new "Archived" wording.
    expect(output).toContain('Archived 1 within-slice duplicate-slug jobs from slice');
    expect(output).toContain('expired');
  }, 30000);

  it('is idempotent: re-running cleanup does not duplicate the archived loser', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'archive-idempotent-test.json');
    const expiredDir = path.join(dir, 'expired');
    const crawlerKey = `archive-idempotent-${Date.now()}`;

    const jobs: CleanupSliceJob[] = [
      buildJob({
        id: 'job-A',
        slug: 'role-shared',
        title: 'Role A',
        crawledAt: daysAgo(10),
      }),
      buildJob({
        id: 'job-B',
        slug: 'role-shared',
        title: 'Role B',
        crawledAt: daysAgo(5),
      }),
    ];

    fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

    // First run: archives the loser.
    const r1 = await runCleanupSlice(slicePath, expiredDir);
    expect(r1.code, r1.stdout + r1.stderr).toBe(0);

    const expiredSlicePath = path.join(expiredDir, `${crawlerKey}.json`);
    const after1: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));
    const losers1 = after1.filter((e) => e.dedupArchive === true);
    expect(losers1.length).toBe(1);
    const loserSlugAfter1 = losers1[0].slug;

    // Second run: slice now contains only the winner (1 job). The cleanup
    // should not crash and the expired file should still hold exactly one
    // entry for the dedup loser (no duplication).
    const r2 = await runCleanupSlice(slicePath, expiredDir);
    expect(r2.code, r2.stdout + r2.stderr).toBe(0);

    const after2: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));
    const losers2 = after2.filter((e) => e.dedupArchive === true);
    expect(losers2.length).toBe(1);
    expect(losers2[0].slug).toBe(loserSlugAfter1);

    // Third run: re-introduce a colliding job to confirm idempotency holds
    // even when the same loser surfaces a second time.
    const sliceAfter2 = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const keptJobs: CleanupSliceJob[] = Array.isArray(sliceAfter2?.jobs) ? sliceAfter2.jobs : sliceAfter2;
    keptJobs.push(buildJob({
      id: 'job-A',
      slug: 'role-shared',
      title: 'Role A',
      crawledAt: daysAgo(10),
    }));
    fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs: keptJobs }, null, 2), 'utf-8');

    const r3 = await runCleanupSlice(slicePath, expiredDir);
    expect(r3.code, r3.stdout + r3.stderr).toBe(0);

    const after3: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));
    const losers3 = after3.filter((e) => e.dedupArchive === true);
    expect(losers3.length).toBe(1);
    expect(losers3[0].slug).toBe(loserSlugAfter1);
  }, 60000);

  it('preserves existing previousSlugs[] entries when archiving a loser', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'archive-prev-slugs-test.json');
    const expiredDir = path.join(dir, 'expired');
    const crawlerKey = `archive-prev-slugs-${Date.now()}`;

    const jobs = [
      {
        ...buildJob({
          id: 'job-loser',
          slug: 'lead-engineer',
          title: 'Lead Engineer (loser)',
          crawledAt: daysAgo(10),
        }),
        previousSlugs: ['legacy-lead-engineer-2025'],
      },
      buildJob({
        id: 'job-winner',
        slug: 'lead-engineer',
        title: 'Lead Engineer (winner)',
        crawledAt: daysAgo(5),
      }),
    ];

    fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

    const result = await runCleanupSlice(slicePath, expiredDir);
    expect(result.code, result.stdout + result.stderr).toBe(0);

    const expiredSlicePath = path.join(expiredDir, `${crawlerKey}.json`);
    const expiredEntries: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));
    const archived = expiredEntries.find((e) => e.dedupArchive === true);
    expect(archived).toBeDefined();
    // Both the legacy and the colliding slug must be preserved.
    expect(archived?.previousSlugs).toContain('legacy-lead-engineer-2025');
    expect(archived?.previousSlugs).toContain('lead-engineer');
  }, 30000);

  // #3411: dedicated crawlers (ferrovia-retica, julius-baer, mikron,
  // relewant, swiss-medical-network, casale) commit slices where `.id` is
  // never stamped (it's only added at data/jobs.json assembly time). Two
  // id-less jobs that both age out (> JOBS_STALE_DAYS) land in
  // `sliceRemoved`, each referenced by `{ id: j.id }` — before the fix that
  // was `{ id: undefined }` for both, so `archiveJobsById.get(undefined)`
  // resolved to whichever job the Map's bare-id keying happened to keep
  // last, archiving one job's content twice under two different slugs
  // instead of each job's own content. These jobs carry no `id` field at
  // all — that's what real per-crawler slices look like.
  it('does not collide id-less slice jobs when archiving age-pruned removals', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'id-less-age-prune-test.json');
    const expiredDir = path.join(dir, 'expired');
    const crawlerKey = `id-less-age-prune-${Date.now()}`;

    const stripId = (job: CleanupSliceJob): Omit<CleanupSliceJob, 'id'> => {
      const { id: _id, ...rest } = job;
      return rest;
    };

    const jobs = [
      stripId(buildJob({
        id: 'job-stale-A',
        slug: 'engineer-lugano-stale',
        title: 'Engineer Lugano (stale A)',
        crawledAt: daysAgo(90),
      })),
      stripId(buildJob({
        id: 'job-stale-B',
        slug: 'designer-bellinzona-stale',
        title: 'Designer Bellinzona (stale B)',
        location: 'Bellinzona',
        addressLocality: 'Bellinzona',
        crawledAt: daysAgo(95),
      })),
      stripId(buildJob({
        id: 'job-fresh-C',
        slug: 'nurse-mendrisio-fresh',
        title: 'Nurse Mendrisio (fresh)',
        location: 'Mendrisio',
        addressLocality: 'Mendrisio',
        crawledAt: daysAgo(1),
      })),
    ];

    fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

    const result = await runCleanupSlice(slicePath, expiredDir);
    const output = result.stdout + result.stderr;
    expect(result.code, output).toBe(0);

    const sliceParsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const keptJobs: CleanupSliceJob[] = Array.isArray(sliceParsed?.jobs) ? sliceParsed.jobs : sliceParsed;
    expect(keptJobs.length).toBe(1);
    expect(keptJobs[0].slug).toBe('nurse-mendrisio-fresh');

    const expiredSlicePath = path.join(expiredDir, `${crawlerKey}.json`);
    expect(fs.existsSync(expiredSlicePath)).toBe(true);
    const expiredEntries: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredSlicePath, 'utf-8'));

    // Before the fix, both stale removals resolved to the same (last-keyed)
    // job under the collapsed `undefined` key — asserting each archived
    // slug carries ITS OWN title (not a copy of the other's) catches that
    // regression; a count-only assertion would pass even with swapped/
    // duplicated content.
    expect(expiredEntries).toHaveLength(2);
    const bySlug = new Map(expiredEntries.map((e) => [e.slug, e]));
    expect(bySlug.get('engineer-lugano-stale')?.title).toBe('Engineer Lugano (stale A)');
    expect(bySlug.get('designer-bellinzona-stale')?.title).toBe('Designer Bellinzona (stale B)');
  }, 30000);

  it('does not collide id-less slice jobs when validating URLs (checkById/fallbackById)', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/apply') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>Application form</body></html>');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const dir = makeTempDir();
      const slicePath = path.join(dir, 'id-less-url-validation-test.json');
      const expiredDir = path.join(dir, 'expired');
      const crawlerKey = `id-less-url-validation-${Date.now()}`;

      const stripId = (job: CleanupSliceJob): Omit<CleanupSliceJob, 'id'> => {
        const { id: _id, ...rest } = job;
        return rest;
      };

      // Both jobs are id-less. One has a dead canonical URL but a live
      // applyUrl fallback (must survive); the other has a fully dead URL
      // with no fallback (must be removed). Before the fix, checkById /
      // fallbackById collapsed both onto the `undefined` key, so either
      // job could inherit the other's validation verdict.
      const jobs = [
        stripId(buildJob({
          id: 'job-fallback-kept',
          slug: 'nurse-live-apply',
          title: 'Nurse With Live Apply URL',
          crawledAt: new Date().toISOString(),
          url: `${baseUrl}/dead-detail-A`,
          applyUrl: `${baseUrl}/apply`,
        })),
        stripId(buildJob({
          id: 'job-dead-removed',
          slug: 'nurse-dead-url',
          title: 'Nurse With Dead URL',
          crawledAt: new Date().toISOString(),
          url: `${baseUrl}/dead-detail-B`,
        })),
      ];

      fs.writeFileSync(slicePath, JSON.stringify({ crawlerKey, jobs }, null, 2), 'utf-8');

      const result = await runCleanupSliceWithUrlValidation(slicePath, expiredDir);
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(0);

      const sliceParsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
      const keptJobs: CleanupSliceJob[] = Array.isArray(sliceParsed?.jobs) ? sliceParsed.jobs : sliceParsed;
      expect(keptJobs).toHaveLength(1);
      expect(keptJobs[0].slug).toBe('nurse-live-apply');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('cleanup-jobs standard mode — archives within-slice slug-dedup losers', () => {
  it('moves losers to data/expired-jobs.json with disambiguated slugs and previousSlugs[]', async () => {
    // Standard mode bakes DATA_JOBS_PATH from __dirname at module load, so we
    // build a sandbox that mirrors the project layout: a symlinked scripts/
    // dir + synthetic data/ and public/data/ trees. --preserve-symlinks
    // forces Node to use the sandbox path for __dirname instead of resolving
    // through the symlink to the real scripts dir.
    const dir = makeTempDir();
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.symlinkSync(path.resolve(process.cwd(), 'scripts'), path.join(sandbox, 'scripts'));
    fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'public', 'data'), { recursive: true });

    const expiredJobsPath = path.join(dir, 'expired-jobs.json');
    const publicExpiredJobsPath = path.join(dir, 'public-expired-jobs.json');

    const jobs = [
      buildJob({
        id: 'std-loser',
        slug: 'data-scientist-lugano',
        title: 'Data Scientist Lugano (loser)',
        crawledAt: daysAgo(10),
      }),
      buildJob({
        id: 'std-winner',
        slug: 'data-scientist-lugano',
        title: 'Data Scientist Lugano (winner)',
        crawledAt: daysAgo(5),
      }),
      buildJob({
        id: 'std-unique',
        slug: 'designer-bellinzona-std',
        title: 'Designer Bellinzona',
        location: 'Bellinzona',
        addressLocality: 'Bellinzona',
        crawledAt: daysAgo(7),
      }),
    ];

    fs.writeFileSync(path.join(sandbox, 'data', 'jobs.json'), JSON.stringify(jobs, null, 2), 'utf-8');
    fs.writeFileSync(path.join(sandbox, 'public', 'data', 'jobs.json'), JSON.stringify(jobs, null, 2), 'utf-8');

    const sandboxScriptPath = path.join(sandbox, 'scripts', 'cleanup-jobs.mjs');
    const result: RunResult = await new Promise<RunResult>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', sandboxScriptPath], {
        env: {
          ...process.env,
          JOBS_SKIP_LOCALE_HARDENING: '1',
          JOBS_SKIP_URL_VALIDATION: '1',
          JOBS_STALE_DAYS: '60',
          JOBS_EXPIRED_JOBS_PATH: expiredJobsPath,
          JOBS_PUBLIC_EXPIRED_JOBS_PATH: publicExpiredJobsPath,
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

    const output = result.stdout + result.stderr;
    expect(result.code, output).toBe(0);

    const sandboxJobs = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'jobs.json'), 'utf-8'));
    expect(Array.isArray(sandboxJobs), output).toBe(true);
    expect(sandboxJobs.length, output).toBe(2);
    const sandboxSlugs = sandboxJobs.map((j: { slug: string }) => j.slug).sort();
    expect(sandboxSlugs).toEqual(['data-scientist-lugano', 'designer-bellinzona-std']);
    const winner = sandboxJobs.find((j: { slug: string; id: string }) => j.slug === 'data-scientist-lugano');
    expect(winner.id).toBe('std-winner');

    // The expired-jobs.json (env-redirected outside the sandbox) should now
    // contain the dedup-archived loser.
    expect(fs.existsSync(expiredJobsPath)).toBe(true);
    const expiredEntries: ExpiredEntry[] = JSON.parse(fs.readFileSync(expiredJobsPath, 'utf-8'));
    const archivedLosers = expiredEntries.filter((e) => e.dedupArchive === true);
    expect(archivedLosers.length).toBe(1);

    const archived = archivedLosers[0];
    expect(archived.slug).not.toBe('data-scientist-lugano');
    expect(archived.slug).toMatch(/-[a-z0-9]{6}$/);
    expect(archived.previousSlugs).toContain('data-scientist-lugano');
    expect(archived.title).toBe('Data Scientist Lugano (loser)');

    expect(output).toContain('Archived 1 within-slice duplicate-slug jobs');
  }, 60000);
});
