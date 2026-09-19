import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeInputHash,
  IncrementalManifest,
} from '../../build-plugins/shared/incrementalManifest.mjs';
import {
  createJobsSeoHtmlReuse,
  htmlReuseCachePath,
  discardJobsSeoReuseProbeVerdicts,
  jobsSeoProbeInheritsEmitterChange,
  jobsSeoProbeShapeHints,
  jobsSeoProbeStratum,
  jobsSeoReuseProbePath,
  jobsSeoReuseProbeTarget,
  JOBS_SEO_REUSE_PROBE_DEFAULTS,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const ENV_KEYS = [
  'JOBS_SEO_REUSE',
  'JOBS_SEO_REUSE_VERIFY',
  'JOBS_SEO_REUSE_VERIFY_SAMPLE',
  'JOBS_SEO_REUSE_PROBE',
  'JOBS_SEO_REUSE_PROBE_RATE',
  'JOBS_SEO_REUSE_PROBE_MIN',
  'JOBS_SEO_REUSE_PROBE_MAX',
  'JOBS_SEO_REUSE_PROBE_PER_STRATUM',
  'JOBS_SEO_REUSE_HTML_CACHE_DIR',
];
const envBefore = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const KINDS = [
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
] as const;

function fingerprints(version: string) {
  return Object.fromEntries(KINDS.map((kind) => [kind, `${kind}:${version}`]));
}

const V1 = fingerprints('v1');
const V2 = fingerprints('v2');

type Page = { path: string; input: Record<string, unknown>; job: Record<string, unknown> };

function pages(count: number, withSalary: (index: number) => boolean = () => false): Page[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `it/lavoro/job-${index}/`,
    input: { jobId: `job-${index}`, locale: 'it', relatedJobs: [], slug: `job-${index}` },
    job: { id: `job-${index}`, salaryMin: withSalary(index) ? 90000 : undefined, location: 'Lugano' },
  }));
}

/** Old renderer output. `salaryBlock` stands for an optional template branch. */
function renderV1(page: Page) {
  const salary = page.job.salaryMin ? `<p class="salary">${page.job.salaryMin}</p>` : '';
  return `<html><head><meta name="ft-build-id" content="1"></head><body><h1>${page.path}</h1>${salary}</body></html>`;
}

function fixture(allPages: Page[], { writeCache = true } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-reuse-probe-'));
  roots.push(rootDir);
  const manifest = new IncrementalManifest('it');
  for (const page of allPages) manifest.register(page.path, 'active-job', page.input);
  manifest.setJobsSeoEmitterFingerprint(V1);
  manifest.write(rootDir, path.join(rootDir, '.cache', 'incremental-manifest-prev'));
  if (writeCache) {
    for (const page of allPages) {
      const file = htmlReuseCachePath(
        rootDir,
        'it',
        page.path,
        null,
        'active-job',
        computeInputHash(page.input, 'active-job'),
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderV1(page), 'utf8');
    }
  }
  return rootDir;
}

function enableProbe({ min = 2, max = 2, perStratum = 1, rate = 0.01 } = {}) {
  process.env.JOBS_SEO_REUSE = '1';
  delete process.env.JOBS_SEO_REUSE_VERIFY;
  process.env.JOBS_SEO_REUSE_PROBE = '1';
  process.env.JOBS_SEO_REUSE_PROBE_MIN = String(min);
  process.env.JOBS_SEO_REUSE_PROBE_MAX = String(max);
  process.env.JOBS_SEO_REUSE_PROBE_PER_STRATUM = String(perStratum);
  process.env.JOBS_SEO_REUSE_PROBE_RATE = String(rate);
}

/** Drive the same lookup → render-or-reuse → finish protocol as the plugin. */
async function build(rootDir: string, allPages: Page[], render: (page: Page) => string) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reuse = (await createJobsSeoHtmlReuse(rootDir, ['it'], V2))!;
  const outcomes: Array<'probe' | 'reuse' | 'render'> = [];
  for (const page of allPages) {
    const candidate = reuse.lookup('it', page.path, 'active-job', page.input, 'active', jobsSeoProbeShapeHints(page.job));
    let html: string;
    if (!candidate.hit || reuse.shouldRender(candidate)) {
      html = render(page);
      outcomes.push(candidate.probe ? 'probe' : 'render');
    } else {
      html = reuse.reusedHtml(candidate, '2') || candidate.html!;
      outcomes.push('reuse');
    }
    reuse.finish(candidate, html);
  }
  reuse.logSummary();
  const verdict = JSON.parse(fs.readFileSync(jobsSeoReuseProbePath(rootDir, 'it'), 'utf8'));
  return { reuse, outcomes, verdict, warn };
}

describe('jobs SEO reuse output probe (JOBS_SEO_REUSE_PROBE)', () => {
  it('inherits validity when changed code renders byte-identical HTML', async () => {
    const allPages = pages(6);
    const rootDir = fixture(allPages);
    enableProbe({ min: 2, max: 2 });
    // Only the build-id marker differs: normalization ignores it.
    const { reuse, outcomes, verdict } = await build(
      rootDir,
      allPages,
      (page) => renderV1(page).replace('content="1"', 'content="2"'),
    );
    expect(outcomes).toEqual(['probe', 'probe', 'reuse', 'reuse', 'reuse', 'reuse']);
    expect(verdict.blocks.active).toMatchObject({
      verdict: 'inherit',
      reason: 'sample-identical',
      sampled: 2,
      identical: 2,
      differing: 0,
      reused: 4,
    });
    expect(verdict.previousFingerprint).toEqual(V1);
    expect(verdict.currentFingerprint).toEqual(V2);
    expect(reuse.summary().active).toMatchObject({ reused: 4, probed: 2, mismatches: 0 });
    process.env.JOBS_SEO_REUSE_PROBE = '1';
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2)).toMatchObject({ inherit: true });
  });

  it('samples every page shape and invalidates when one covered shape changes', async () => {
    // Target 2 is reached on salary-less pages; the first salary page is a new
    // stratum and is probed before any page of that shape can be reused.
    const allPages = pages(6, (index) => index >= 3);
    const rootDir = fixture(allPages);
    enableProbe({ min: 2, max: 2, perStratum: 1 });
    const renderV2 = (page: Page) => renderV1(page).replace('class="salary"', 'class="salary salary--v2"');
    const { outcomes, verdict, warn } = await build(rootDir, allPages, renderV2);
    expect(outcomes).toEqual(['probe', 'probe', 'reuse', 'probe', 'render', 'render']);
    expect(verdict.blocks.active).toMatchObject({
      verdict: 'invalidate',
      differing: 1,
      reusedBeforeInvalidate: 1,
    });
    expect(verdict.blocks.active.reason).toMatch(/^output-differs:/);
    expect(warn.mock.calls.flat().join('\n')).toContain('[jobs-seo-reuse-probe] differing block=active');
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2)).toMatchObject({
      inherit: false,
      reason: 'probe-invalidate:it:active',
    });
  });

  it('invalidates when the cache cannot produce a page', async () => {
    const allPages = pages(4);
    const rootDir = fixture(allPages, { writeCache: false });
    enableProbe();
    const { outcomes, verdict } = await build(rootDir, allPages, renderV1);
    expect(outcomes).toEqual(['render', 'render', 'render', 'render']);
    expect(verdict.blocks.active).toMatchObject({ verdict: 'invalidate', reason: 'cache-unavailable' });
  });

  it('invalidates when the cached HTML is corrupt', async () => {
    const allPages = pages(4);
    const rootDir = fixture(allPages);
    const corrupt = htmlReuseCachePath(
      rootDir,
      'it',
      allPages[0].path,
      null,
      'active-job',
      computeInputHash(allPages[0].input, 'active-job'),
    );
    fs.writeFileSync(corrupt, '<html><body>\u0000truncated', 'utf8');
    enableProbe();
    const { outcomes, verdict } = await build(rootDir, allPages, renderV1);
    expect(outcomes).toEqual(['probe', 'render', 'render', 'render']);
    expect(verdict.blocks.active.verdict).toBe('invalidate');
  });

  it('keeps the hard invalidation when the flag is off', async () => {
    const allPages = pages(3);
    const rootDir = fixture(allPages);
    enableProbe();
    delete process.env.JOBS_SEO_REUSE_PROBE;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reuse = (await createJobsSeoHtmlReuse(rootDir, ['it'], V2))!;
    const candidate = reuse.lookup('it', allPages[0].path, 'active-job', allPages[0].input, 'active');
    expect(candidate.hit).toBe(false);
    reuse.finish(candidate, renderV1(allPages[0]));
    reuse.logSummary();
    expect(reuse.summary().active.missReasons).toEqual({ 'emitter-fingerprint-changed': 1 });
    expect(fs.existsSync(jobsSeoReuseProbePath(rootDir, 'it'))).toBe(false);
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2).inherit).toBe(false);
  });

  it('rejects a verdict file bound to other fingerprints', async () => {
    const allPages = pages(3);
    const rootDir = fixture(allPages);
    enableProbe({ min: 1, max: 1 });
    await build(rootDir, allPages, renderV1);
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2).inherit).toBe(true);
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, fingerprints('v3'))).toMatchObject({
      inherit: false,
      reason: 'probe-verdict-stale:it',
    });
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it', 'en'], V1, V2)).toMatchObject({
      inherit: false,
      reason: 'probe-verdict-missing:en',
    });
  });
});

describe('the verdict sidecar belongs to one build only', () => {
  it('discards a verdict restored from another build before anyone reads it', async () => {
    const allPages = pages(3);
    const rootDir = fixture(allPages);
    const restored = jobsSeoReuseProbePath(rootDir, 'it');
    fs.mkdirSync(path.dirname(restored), { recursive: true });
    // A cache restore can carry the verdict of the PREVIOUS build, with the
    // same fingerprint pair: it must not answer for this build's probe.
    fs.writeFileSync(restored, JSON.stringify({
      version: 2,
      buildId: 'another-build',
      locale: 'it',
      previousFingerprint: V1,
      currentFingerprint: V2,
      blocks: { active: { verdict: 'inherit' } },
    }));
    process.env.JOBS_SEO_REUSE_PROBE = '1';
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2)).toMatchObject({
      inherit: false,
      reason: 'probe-verdict-foreign-build:it',
    });
    enableProbe({ min: 1, max: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createJobsSeoHtmlReuse(rootDir, ['it'], V2);
    expect(fs.existsSync(restored)).toBe(false);
  });

  it('leaves no verdict behind when the write fails', async () => {
    const allPages = pages(3);
    const rootDir = fixture(allPages);
    enableProbe({ min: 1, max: 1 });
    const stale = jobsSeoReuseProbePath(rootDir, 'it');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reuse = (await createJobsSeoHtmlReuse(rootDir, ['it'], V2))!;
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, JSON.stringify({ version: 2, buildId: 'another-build' }));
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes('probe-it.json')) throw new Error('disk full');
      return (realWrite as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    reuse.logSummary();
    vi.mocked(fs.writeFileSync).mockRestore();
    expect(fs.existsSync(stale)).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toContain('verdict=discarded');
    expect(jobsSeoProbeInheritsEmitterChange(rootDir, ['it'], V1, V2).inherit).toBe(false);
  });

  it('exposes the discard helper for callers that skip the reuse object', () => {
    const rootDir = fixture(pages(1));
    const file = jobsSeoReuseProbePath(rootDir, 'it');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    discardJobsSeoReuseProbeVerdicts(rootDir, ['it']);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('probe sizing and strata', () => {
  it('clamps the per-block target between min and max', () => {
    const config = { ...JOBS_SEO_REUSE_PROBE_DEFAULTS };
    expect(jobsSeoReuseProbeTarget(0, config)).toBe(0);
    expect(jobsSeoReuseProbeTarget(150, config)).toBe(150);
    expect(jobsSeoReuseProbeTarget(2650, config)).toBe(200);
    expect(jobsSeoReuseProbeTarget(33000, config)).toBe(495);
    expect(jobsSeoReuseProbeTarget(364000, config)).toBe(5000);
  });

  it('separates optional template branches into distinct strata', () => {
    const input = { jobId: 'a', relatedJobs: [], slug: 'a', action: 'full' };
    const plain = jobsSeoProbeStratum('active-job', 'it', input, jobsSeoProbeShapeHints({ location: 'Lugano' }));
    const salary = jobsSeoProbeStratum('active-job', 'it', input, jobsSeoProbeShapeHints({ location: 'Lugano', salaryMin: 1 }));
    const multi = jobsSeoProbeStratum('active-job', 'it', input, jobsSeoProbeShapeHints({ location: 'Lugano, Mendrisio' }));
    const related = jobsSeoProbeStratum('active-job', 'it', { ...input, relatedJobs: [{}, {}, {}, {}] }, null);
    const thin = jobsSeoProbeStratum('active-job', 'it', { ...input, action: 'thin' }, null);
    expect(new Set([plain, salary, multi, related, thin]).size).toBe(5);
    // Per-page identity and free text stay presence-only: including them would
    // give every page its own stratum and the probe could never generalize.
    expect(jobsSeoProbeStratum('active-job', 'it', { ...input, jobId: 'b', slug: 'b' }, null))
      .toBe(jobsSeoProbeStratum('active-job', 'it', input, null));
  });

  it('splits strata on any string nobody enumerated', () => {
    // The dangerous case: a branch selected by a value that is not in any
    // allowlist. The default must be to separate, never to share a verdict.
    const base = { jobId: 'a', slug: 'a', tier: 'full', unknownFutureField: 'alpha' };
    const other = { ...base, tier: 'thin' };
    const future = { ...base, unknownFutureField: 'beta' };
    expect(jobsSeoProbeStratum('active-job', 'it', base, null))
      .not.toBe(jobsSeoProbeStratum('active-job', 'it', other, null));
    expect(jobsSeoProbeStratum('active-job', 'it', base, null))
      .not.toBe(jobsSeoProbeStratum('active-job', 'it', future, null));
    // The same holds for the branch-selecting values read off the job record.
    const withContract = jobsSeoProbeShapeHints({ contract: 'CDI', sector: 'sanita' });
    const withOtherContract = jobsSeoProbeShapeHints({ contract: 'CDD', sector: 'sanita' });
    const withOtherSector = jobsSeoProbeShapeHints({ contract: 'CDI', sector: 'edilizia' });
    expect(jobsSeoProbeStratum('active-job', 'it', base, withContract))
      .not.toBe(jobsSeoProbeStratum('active-job', 'it', base, withOtherContract));
    expect(jobsSeoProbeStratum('active-job', 'it', base, withContract))
      .not.toBe(jobsSeoProbeStratum('active-job', 'it', base, withOtherSector));
  });

  it('never lets a page inherit from a stratum it does not belong to', async () => {
    // Two contract values, identical in the cache; the renderer changes only
    // the CDD branch. The CDI samples must not authorize the CDD pages.
    const allPages = pages(6).map((page, index) => ({
      ...page,
      job: { ...page.job, contract: index >= 3 ? 'CDD' : 'CDI' },
    }));
    const rootDir = fixture(allPages);
    enableProbe({ min: 2, max: 2, perStratum: 1 });
    const { outcomes, verdict } = await build(
      rootDir,
      allPages,
      (page) => (page.job.contract === 'CDD'
        ? renderV1(page).replace('<body>', '<body data-contract="cdd">')
        : renderV1(page)),
    );
    expect(outcomes).toEqual(['probe', 'probe', 'reuse', 'probe', 'render', 'render']);
    expect(verdict.blocks.active).toMatchObject({ verdict: 'invalidate', differing: 1 });
  });
});
