import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeInputHash,
  IncrementalManifest,
} from '../../build-plugins/shared/incrementalManifest.mjs';
import {
  computeJobsSeoEmitterFingerprints,
  createJobsSeoHtmlReuse,
  diagnoseHtmlReuseMismatch,
  htmlHasIndexableRobots,
  htmlReuseCachePath,
  JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV,
  normalizeHtmlForReuse,
  refreshHtmlBuildId,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const FINGERPRINT_ENV_KEYS = [
  'STRIP_ACTIVE_JOB_PROSE',
  'STRIP_EXPIRED_JOB_PROSE',
  'JOBS_SEO_SKIP_MINIFY',
  'KILL_JOBLIST_INFEED_EXPERIMENT',
  'ASSET_CDN',
  'FAST_BUILD',
];
const envBefore = Object.fromEntries([
  'JOBS_SEO_REUSE',
  'JOBS_SEO_REUSE_VERIFY',
  JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV,
  ...FINGERPRINT_ENV_KEYS,
].map((key) => [key, process.env[key]]));

const FINGERPRINT_ASSET_FILES = [
  'build-plugins/shared/spaEntryFilenames.ts',
  'index.css',
  'vite.config.ts',
  'public/assets/seo-static.css',
  'public/assets/bridge.css',
  'public/assets/logo.svg',
  'public/favicon.ico',
  'public/favicon.svg',
];

const TEST_EMITTER_FINGERPRINT_KINDS = [
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
] as const;

function testEmitterFingerprints(version: string) {
  return Object.fromEntries(
    TEST_EMITTER_FINGERPRINT_KINDS.map((kind) => [kind, `${kind}:${version}`]),
  );
}

const TEST_EMITTER_FINGERPRINTS = testEmitterFingerprints('v1');

afterEach(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-reuse-test-'));
}

function writeFixtureFile(rootDir: string, relativeFile: string, contents: string) {
  const file = path.join(rootDir, relativeFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function fingerprintFixtureRoot() {
  const rootDir = fixtureRoot();
  writeFixtureFile(rootDir, 'build-plugins/jobsSeoPagesPlugin.ts', 'export const renderVersion = "v1";\n');
  writeFixtureFile(rootDir, 'index.tsx', 'import "./src/unrelated-spa-module.ts";\n');
  writeFixtureFile(rootDir, 'src/unrelated-spa-module.ts', 'export const spaVersion = "v1";\n');
  for (const relativeFile of FINGERPRINT_ASSET_FILES) {
    writeFixtureFile(rootDir, relativeFile, `fixture:${relativeFile}:v1\n`);
  }
  return rootDir;
}

function clearFingerprintEnv() {
  for (const key of FINGERPRINT_ENV_KEYS) delete process.env[key];
}

function writePreviousManifest(
  rootDir: string,
  pagePath: string,
  kind: string,
  input: unknown,
  emitterFingerprints = TEST_EMITTER_FINGERPRINTS,
) {
  const manifest = new IncrementalManifest('it');
  manifest.register(pagePath, kind, input);
  manifest.setJobsSeoEmitterFingerprint(emitterFingerprints);
  manifest.write(rootDir, path.join(rootDir, '.cache', 'incremental-manifest-prev'));
}

function writeCachedHtml(rootDir: string, pagePath: string, html: string) {
  const file = htmlReuseCachePath(rootDir, 'it', pagePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
}

async function createReuse(
  rootDir: string,
  verify = false,
  emitterFingerprints = TEST_EMITTER_FINGERPRINTS,
) {
  process.env.JOBS_SEO_REUSE = '1';
  if (verify) process.env.JOBS_SEO_REUSE_VERIFY = '1';
  else delete process.env.JOBS_SEO_REUSE_VERIFY;
  return (await createJobsSeoHtmlReuse(rootDir, ['it'], emitterFingerprints))!;
}

describe('jobs SEO disk HTML reuse', () => {
  it('is disabled unless JOBS_SEO_REUSE=1', async () => {
    const rootDir = fixtureRoot();
    try {
      delete process.env.JOBS_SEO_REUSE;
      expect(await createJobsSeoHtmlReuse(rootDir, ['it'])).toBeNull();
      expect(fs.existsSync(path.join(rootDir, '.cache'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reuses a previous page when kind, input hash, emitter fingerprint, and HTML all match', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/fixture/';
    const input = { jobId: 'job-1', locale: 'it', slug: 'fixture' };
    const html = '<html><head><meta name="robots" content="index,follow"></head><body>fixture</body></html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, html);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      expect(candidate).toMatchObject({ hit: true, html });
      expect(refreshHtmlBuildId('<meta name="ft-build-id" content="old">', '123')).toContain('content="123"');
      reuse.finish(candidate, html);
      expect(reuse.summary().active).toMatchObject({
        rendered: 0,
        reused: 1,
        reusable: 1,
        verified: 0,
        mismatches: 0,
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('renders when the emitter fingerprint changes even with the same input hash', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/fingerprint-change/';
    const input = { jobId: 'job-1', locale: 'it', slug: 'fingerprint-change' };
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input, testEmitterFingerprints('old'));
      writeCachedHtml(rootDir, pagePath, '<html>old-emitter</html>');
      const reuse = await createReuse(rootDir, false, testEmitterFingerprints('new'));
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>new-emitter</html>');
      expect(reuse.summary().active).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'emitter-fingerprint-changed': 1 },
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('renders on an input-hash miss and records the reason', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/fixture/';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', { value: 'old' });
      writeCachedHtml(rootDir, pagePath, '<html>old</html>');
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', { value: 'new' }, 'active');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>new</html>');
      expect(reuse.summary().active).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'input-hash-changed': 1 },
      });
      expect(fs.readFileSync(htmlReuseCachePath(rootDir, 'it', pagePath), 'utf8')).toBe('<html>new</html>');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('renders on a matching hash when the previous HTML is unavailable', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/missing-html/';
    const input = { value: 'same' };
    try {
      writePreviousManifest(rootDir, pagePath, 'expired-soft-landing', input);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'expired-soft-landing', input, 'expired-soft-landing');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>fresh</html>');
      expect(reuse.summary()['expired-soft-landing']).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'html-unavailable': 1 },
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reuses an expired soft-landing without rendering its HTML', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/expired-fixture/';
    const input = { value: 'same' };
    const html = '<html><body>expired</body></html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'expired-soft-landing', input);
      writeCachedHtml(rootDir, pagePath, html);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'expired-soft-landing', input, 'expired-soft-landing');
      expect(reuse.reusedHtml(candidate, '123')).toContain('expired');
      reuse.finish(candidate, html);
      expect(reuse.summary()['expired-soft-landing']).toMatchObject({
        rendered: 0,
        reused: 1,
        reusable: 1,
        verified: 0,
        mismatches: 0,
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('verify mode renders a hit and reports normalized-output mismatches', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify/';
    const input = { value: 'same' };
    const previousHtml = '<meta name="ft-build-id" content="old"><lastmod>2026-09-16</lastmod><p>old content</p>';
    const currentHtml = '<meta name="ft-build-id" content="new"><lastmod>2026-09-17</lastmod><p>new content</p>';
    try {
      writePreviousManifest(rootDir, pagePath, 'cross-locale-reconciliation', input);
      writeCachedHtml(rootDir, pagePath, previousHtml);
      const reuse = await createReuse(rootDir, true);
      const candidate = reuse.lookup('it', pagePath, 'cross-locale-reconciliation', input, 'cross-locale-reconciliation');
      expect(candidate.hit).toBe(true);
      reuse.finish(candidate, currentHtml);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let logLines: string[] = [];
      try {
        reuse.logSummary();
      } finally {
        logLines = logSpy.mock.calls.map(([line]) => String(line));
        logSpy.mockRestore();
      }
      expect(logLines.some((line) => line.includes(
        'block=cross-locale-reconciliation mode=verify-render rendered=1 reused=0 reusable=1 verified=1',
      ))).toBe(true);
      expect(reuse.summary()['cross-locale-reconciliation']).toMatchObject({
        rendered: 1,
        reused: 0,
        reusable: 1,
        verified: 1,
        mismatches: 1,
        mismatchReasons: { 'html-content-changed': 1 },
      });
      const artifact = JSON.parse(fs.readFileSync(
        path.join(rootDir, '.cache', 'incremental-html', 'verify-it.json'),
        'utf8',
      ));
      expect(artifact).toMatchObject({ version: 1, locale: 'it' });
      expect(artifact.mismatches[0]).toMatchObject({
        block: 'cross-locale-reconciliation',
        path: 'cerca-lavoro-ticino/verify/',
        reason: 'html-content-changed',
      });
      expect(artifact.mismatches[0].offset).toBeGreaterThan(0);
      expect(artifact.mismatches[0].expectedContext).toContain('old content');
      expect(artifact.mismatches[0].actualContext).toContain('new content');
      expect(artifact.mismatches[0].expectedContext.length).toBeLessThanOrEqual(120);
      expect(artifact.mismatches[0].actualContext.length).toBeLessThanOrEqual(120);
      expect(normalizeHtmlForReuse(previousHtml)).not.toBe(normalizeHtmlForReuse(currentHtml));
      expect(htmlHasIndexableRobots('<meta name="robots" content="index,follow">')).toBe(true);
      expect(htmlHasIndexableRobots('<meta name="robots" content="noindex,follow">')).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('scopes the emitter fingerprint to the job render graph, not the SPA source graph', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'src/unrelated-spa-module.ts', 'export const spaVersion = "v2";\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('changes the emitter fingerprint when the render entry changes', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'build-plugins/jobsSeoPagesPlugin.ts', 'export const renderVersion = "v2";\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('changes the emitter fingerprint when a render flag changes', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      process.env.STRIP_ACTIVE_JOB_PROSE = '0';
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('changes the emitter fingerprint when a referenced asset changes', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'public/assets/seo-static.css', 'fixture:seo-static.css:v2\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('verify mode classifies asset-reference mismatches separately', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify-asset/';
    const input = { value: 'same' };
    const previousHtml = '<link rel="stylesheet" href="/assets/seo-static.css"><p>same</p>';
    const currentHtml = '<link rel="stylesheet" href="/assets/seo-static-v2.css"><p>same</p>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, previousHtml);
      const reuse = await createReuse(rootDir, true);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      reuse.finish(candidate, currentHtml);
      expect(reuse.summary().active.mismatchReasons).toEqual({ 'asset-reference-changed': 1 });
      const diagnostic = diagnoseHtmlReuseMismatch(
        previousHtml,
        currentHtml,
        'asset-reference-changed',
      );
      expect(diagnostic.asset).toEqual({
        expected: 'link:href:/assets/seo-static.css',
        actual: 'link:href:/assets/seo-static-v2.css',
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('ignores data-src and data-href when classifying HTML assets', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify-data-attributes/';
    const input = { value: 'same' };
    const previousHtml = '<img data-src="/assets/old.svg"><p>same</p>';
    const currentHtml = '<img data-src="/assets/new.svg"><p>same</p>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, previousHtml);
      const reuse = await createReuse(rootDir, true);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      reuse.finish(candidate, currentHtml);
      expect(reuse.summary().active.mismatchReasons).toEqual({ 'html-content-changed': 1 });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('verify mode classifies inline mismatches separately', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify-inline/';
    const input = { value: 'same' };
    const previousHtml = '<script>window.__JOB_SEED__={"version":1};</script><p>same</p>';
    const currentHtml = '<script>window.__JOB_SEED__={"version":2};</script><p>same</p>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, previousHtml);
      const reuse = await createReuse(rootDir, true);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      reuse.finish(candidate, currentHtml);
      expect(reuse.summary().active.mismatchReasons).toEqual({ 'inline-content-changed': 1 });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('uses a deterministic, explicit sample for verify mode', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify-sample/';
    const input = { value: 'same' };
    const html = '<html><body>same</body></html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, html);
      process.env[JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV] = '0';
      const skipped = await createReuse(rootDir, true);
      const skippedCandidate = skipped.lookup('it', pagePath, 'active-job', input, 'active');
      expect(skippedCandidate.verify).toBe(false);
      expect(skipped.shouldRender(skippedCandidate)).toBe(false);
      skipped.finish(skippedCandidate, html);
      expect(skipped.summary().active).toMatchObject({ rendered: 0, reused: 1, reusable: 1, verified: 0 });

      process.env[JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV] = '0.5';
      const first = await createReuse(rootDir, true);
      const second = await createReuse(rootDir, true);
      expect(first.lookup('it', pagePath, 'active-job', input, 'active').verify)
        .toBe(second.lookup('it', pagePath, 'active-job', input, 'active').verify);

      process.env[JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV] = '2';
      await expect(createReuse(rootDir, true)).rejects.toThrow(
        `${JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV} must be a number between 0 and 1`,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('expires reuse input when the deterministic build day changes', () => {
    const base = { jobId: 'job-1', renderDateBucket: '2026-09-18' };
    expect(computeInputHash(base, 'active-job')).toBe(computeInputHash({ ...base }, 'active-job'));
    expect(computeInputHash(base, 'active-job')).not.toBe(
      computeInputHash({ ...base, renderDateBucket: '2026-09-19' }, 'active-job'),
    );
  });

  it('includes statically imported JSON content in the renderer fingerprint', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        'import "./shared/render-data.json";\nexport const renderVersion = "v1";\n',
      );
      writeFixtureFile(rootDir, 'build-plugins/shared/render-data.json', '{"version":1}\n');
      const before = computeJobsSeoEmitterFingerprints(rootDir);
      writeFixtureFile(rootDir, 'build-plugins/shared/render-data.json', '{"version":2}\n');
      const after = computeJobsSeoEmitterFingerprints(rootDir);
      expect(after).not.toEqual(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
