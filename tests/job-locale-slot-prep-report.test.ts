// @vitest-environment node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOTATION_TITLE,
  SLUG_SAMPLE_LIMIT,
  attributeCrawlerKeys,
  collectBlockedJobs,
  escapeAnnotationData,
  formatAnnotations,
  formatStepSummary,
  groupBlockedByCrawler,
  reportBlockingLocaleSlots,
} from '../scripts/lib/job-locale-slot-prep-report.mjs';
import { collectBlockingIssues } from '../scripts/validate-translation-completeness.mjs';

/**
 * The dist gate (`validate:translation-completeness`) blocked the 2026-10-03
 * publish on two SRG SSR records, and nothing in `prep` had named them: the
 * only way to find the parser was to download the build's jobs-master artifact.
 * cleanup-jobs.mjs now re-reads the dataset it wrote and runs the gate's own
 * predicate on it — on EVERY exit path of the dataset mode, as a report that
 * neither removes records nor changes the exit code.
 */

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-jobs.mjs');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempDir(prefix = 'job-locale-slot-prep-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const LONG_DESCRIPTION = 'Descrizione completa della posizione con responsabilita, requisiti, condizioni di lavoro, sede e modalita di candidatura per il ruolo offerto in Ticino.';

type Job = Record<string, unknown> & { id: string; slug: string };

function completeJob(overrides: Partial<Job> & { id: string; slug: string }): Job {
  const title = String(overrides.title ?? 'Contabile senior');
  return {
    url: `https://careers.example.test/jobs/${overrides.id}`,
    title,
    company: 'Acme SA',
    location: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    sourceLang: 'it',
    source: 'Acme Dedicated Parser',
    crawledAt: daysAgo(2),
    description: LONG_DESCRIPTION,
    titleByLocale: Object.fromEntries(LOCALES.map((l) => [l, `${title} ${l}`])),
    descriptionByLocale: Object.fromEntries(LOCALES.map((l) => [l, LONG_DESCRIPTION])),
    slugByLocale: Object.fromEntries(LOCALES.map((l) => [l, overrides.slug])),
    ...overrides,
  };
}

/** A record with no title anywhere: not repairable, so it stays blocking. */
function titlelessJob(id: string, slug: string): Job {
  return completeJob({
    id,
    slug,
    title: '',
    source: 'Titleless Dedicated Parser',
    titleByLocale: {},
  });
}

describe('collectBlockedJobs — the dist gate predicate, per record', () => {
  it('returns exactly the records collectBlockingIssues blocks, with their own issues', () => {
    const clean = completeJob({ id: 'clean-1', slug: 'clean-1' });
    const missingIt = completeJob({ id: 'gap-1', slug: 'gap-1' });
    (missingIt.titleByLocale as Record<string, string>).it = '';

    const blocked = collectBlockedJobs([clean, missingIt]);

    expect(blocked.map((b) => b.job.id)).toEqual(['gap-1']);
    expect(blocked[0].issues).toEqual(collectBlockingIssues([missingIt]));
    expect(blocked[0].issues.map((i) => i.locale)).toEqual(['it']);
  });

  it('skips non-object entries instead of losing the whole report', () => {
    const blocking = titlelessJob('gap-2', 'gap-2');

    const blocked = collectBlockedJobs([null, blocking, 'junk'] as unknown as object[]);

    expect(blocked.map((b) => b.job.id)).toEqual(['gap-2']);
  });
});

describe('attributeCrawlerKeys / groupBlockedByCrawler', () => {
  it('names the slice holding the record (by id even after a slug rename) and falls back to source', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'acme-parser.json'), JSON.stringify({
      crawlerKey: 'acme-parser',
      jobs: [{ id: 'acme-1', slug: 'original-slug-before-hardening', url: 'https://careers.example.test/jobs/acme-1' }],
    }));
    // A scratch companion is not a slice and must not be read as one.
    fs.writeFileSync(path.join(dir, 'acme-parser-locale-cache.json'), JSON.stringify([{ id: 'orphan-1' }]));

    const inSlice = titlelessJob('acme-1', 'renamed-slug');
    const orphan = titlelessJob('orphan-1', 'orphan-slug');
    const anonymous = { ...titlelessJob('anon-1', 'anon-slug'), source: '' };

    const byJob = attributeCrawlerKeys([inSlice, orphan, anonymous], dir);
    const groups = groupBlockedByCrawler(collectBlockedJobs([inSlice, orphan, anonymous]), byJob);

    expect(groups.map((g) => g.crawler).sort()).toEqual(['(unknown)', 'Titleless Dedicated Parser', 'acme-parser']);
    const acme = groups.find((g) => g.crawler === 'acme-parser');
    expect(acme?.slugs).toEqual(['renamed-slug']);
    expect(acme?.issues).toBe(LOCALES.length);
  });

  it('caps the slug sample per crawler but counts every record', () => {
    const jobs = Array.from({ length: SLUG_SAMPLE_LIMIT + 2 }, (_, i) => titlelessJob(`t-${i}`, `t-slug-${i}`));
    const [group] = groupBlockedByCrawler(collectBlockedJobs(jobs), new Map());

    expect(group.jobs).toBe(jobs.length);
    expect(group.slugs).toHaveLength(SLUG_SAMPLE_LIMIT);
    expect(formatAnnotations([group], 'cleanup-jobs')[0]).toContain(`(+${jobs.length - SLUG_SAMPLE_LIMIT} more)`);
  });
});

describe('annotation and summary formatting', () => {
  it('emits one ::error per crawler with the fixed title and escaped data', () => {
    const [line] = formatAnnotations([
      { crawler: 'srg-ssr', jobs: 1, issues: LOCALES.length, slugs: ['a%b\nc'], reasons: [] },
    ], 'cleanup-jobs');
    expect(line.startsWith(`::error title=${ANNOTATION_TITLE}::crawler srg-ssr: 1 job(s)`)).toBe(true);
    expect(line).toContain(escapeAnnotationData('a%b\nc'));
    expect(line).not.toContain('\n');
  });

  it('renders a table row per crawler and says it removed nothing', () => {
    const summary = formatStepSummary([
      { crawler: 'srg|ssr', jobs: 1, issues: 1, slugs: ['x'], reasons: ['it: missing/short title (0 chars)'] },
    ], { total: 10, stage: 'cleanup-jobs' });
    expect(summary).toContain('| srg\\|ssr | 1 | 1 | it: missing/short title (0 chars) | x |');
    expect(summary).toContain('no record was removed and the exit code is unchanged');
  });
});

describe('reportBlockingLocaleSlots — never throws, never fails the caller', () => {
  it('stays silent when there is no dataset and warns (without throwing) on an unreadable one', () => {
    const dir = makeTempDir();
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);

    expect(reportBlockingLocaleSlots({ dataJobsPath: path.join(dir, 'missing.json'), slicesDir: dir, log })).toBeNull();
    expect(lines).toEqual([]);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json');
    expect(reportBlockingLocaleSlots({ dataJobsPath: broken, slicesDir: dir, log })).toBeNull();
    expect(lines.join('\n')).toContain(`::warning title=${ANNOTATION_TITLE}::`);
  });
});

interface RunResult {
  code: number | null;
  output: string;
}

/**
 * Standard mode bakes DATA_JOBS_PATH from __dirname, so the script runs from a
 * sandbox mirroring the project layout (same recipe as
 * tests/cleanup-jobs-archive-dedup-losers.test.ts).
 */
function makeSandbox(jobs: Job[], slices: Record<string, Job[]>) {
  const dir = makeTempDir('cleanup-jobs-locale-slots-');
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(path.join(sandbox, 'data', 'jobs', 'by-crawler'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'public', 'data'), { recursive: true });
  fs.symlinkSync(path.resolve(process.cwd(), 'scripts'), path.join(sandbox, 'scripts'));
  fs.symlinkSync(path.resolve(process.cwd(), 'node_modules'), path.join(sandbox, 'node_modules'));
  fs.symlinkSync(path.resolve(process.cwd(), 'packages'), path.join(sandbox, 'packages'));
  fs.symlinkSync(
    path.resolve(process.cwd(), 'data', 'canton-municipalities.json'),
    path.join(sandbox, 'data', 'canton-municipalities.json'),
  );
  fs.writeFileSync(path.join(sandbox, 'data', 'jobs.json'), JSON.stringify(jobs, null, 2));
  fs.writeFileSync(path.join(sandbox, 'public', 'data', 'jobs.json'), JSON.stringify(jobs, null, 2));
  for (const [key, sliceJobs] of Object.entries(slices)) {
    fs.writeFileSync(
      path.join(sandbox, 'data', 'jobs', 'by-crawler', `${key}.json`),
      JSON.stringify({ crawlerKey: key, assembledAt: daysAgo(0), jobs: sliceJobs }, null, 2),
    );
  }
  return {
    dir,
    sandbox,
    dataJobsPath: path.join(sandbox, 'data', 'jobs.json'),
    summaryPath: path.join(dir, 'step-summary.md'),
  };
}

function runCleanup(sb: ReturnType<typeof makeSandbox>): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ['--preserve-symlinks', '--preserve-symlinks-main', path.join(sb.sandbox, 'scripts', 'cleanup-jobs.mjs')],
      {
        env: {
          ...process.env,
          JOBS_SKIP_URL_VALIDATION: '1',
          JOBS_STALE_DAYS: '60',
          JOBS_HOUSEKEEPING_SCOPE: '',
          JOBS_SLICE_FILE: '',
          JOBS_EXPIRED_JOBS_PATH: path.join(sb.dir, 'expired-jobs.json'),
          JOBS_PUBLIC_EXPIRED_JOBS_PATH: path.join(sb.dir, 'public-expired-jobs.json'),
          JOBS_EXPIRED_SLICES_DIR: path.join(sb.dir, 'expired-slices'),
          GITHUB_STEP_SUMMARY: sb.summaryPath,
          GITHUB_SHA: 'test-locale-slot-sha',
          GITHUB_RUN_ID: 'test-locale-slot-run',
          GITHUB_RUN_ATTEMPT: '1',
        },
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, output }));
  });
}

function readJobs(file: string): Job[] {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('cleanup-jobs.mjs dataset mode — names the blocking records on every exit path', () => {
  it('early-return path (nothing removed): names crawler and slug, keeps every record, exit code 0', async () => {
    const blockedJob = titlelessJob('rtr-1', 'rtr-titleless-posting');
    const jobs = [completeJob({ id: 'ok-1', slug: 'ok-posting-1' }), blockedJob];
    const sb = makeSandbox(jobs, { 'srg-ssr': [blockedJob] });

    const result = await runCleanup(sb);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Nessun job da rimuovere');
    expect(result.output).toContain(`::error title=${ANNOTATION_TITLE}::crawler srg-ssr: 1 job(s)`);
    expect(result.output).toContain('rtr-titleless-posting');
    // Report only: the record is still published, nothing was filtered out.
    expect(readJobs(sb.dataJobsPath).map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
    const summary = fs.readFileSync(sb.summaryPath, 'utf8');
    expect(summary).toContain(`### ${ANNOTATION_TITLE} (cleanup-jobs)`);
    expect(summary).toContain('| srg-ssr | 1 |');
  }, 60000);

  it('prints a stable RSS probe line with numbers, without changing the verdict or exit code', async () => {
    const jobs = [
      completeJob({ id: 'ok-1', slug: 'ok-posting-1', title: 'Contabile senior' }),
      completeJob({ id: 'ok-2', slug: 'ok-posting-2', title: 'Infermiere diplomato' }),
    ];
    const sb = makeSandbox(jobs, {});

    const result = await runCleanup(sb);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/::notice::cleanup-jobs report: peak RSS \d+ MB \(reparse \d+(\.\d+)? s\)/);
  }, 60000);

  it('early-return path on a clean dataset: the check still runs and reports zero', async () => {
    // Distinct titles: hardening re-derives slugs from title + company + city,
    // and two equal titles would collapse into a duplicate-slug removal.
    const jobs = [
      completeJob({ id: 'ok-1', slug: 'ok-posting-1', title: 'Contabile senior' }),
      completeJob({ id: 'ok-2', slug: 'ok-posting-2', title: 'Infermiere diplomato' }),
    ];
    const sb = makeSandbox(jobs, {});

    const result = await runCleanup(sb);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Nessun job da rimuovere');
    expect(result.output).toContain(`Locale slots (cleanup-jobs): 0/${jobs.length} jobs would fail`);
    expect(result.output).not.toContain(`::error title=${ANNOTATION_TITLE}`);
    expect(fs.existsSync(sb.summaryPath)).toBe(false);
  }, 60000);

  it('final-write path (a duplicate slug removed): the report reads the file written last', async () => {
    const blockedJob = titlelessJob('rtr-2', 'rtr-titleless-second');
    const jobs = [
      completeJob({ id: 'dup-old', slug: 'shared-slug', crawledAt: daysAgo(9) }),
      completeJob({ id: 'dup-new', slug: 'shared-slug', crawledAt: daysAgo(1) }),
      blockedJob,
    ];
    const sb = makeSandbox(jobs, { 'srg-ssr': [blockedJob] });

    const result = await runCleanup(sb);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('jobs.json aggiornati');
    const written = readJobs(sb.dataJobsPath);
    expect(written.length).toBe(jobs.length - 1);
    expect(result.output).toContain(`Locale slots (cleanup-jobs): 1/${written.length} jobs would fail`);
    expect(result.output).toContain('rtr-titleless-second');
  }, 60000);
});
