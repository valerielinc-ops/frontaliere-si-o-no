import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeInputHash,
  IncrementalManifest,
} from '../../build-plugins/shared/incrementalManifest.mjs';
import {
  collectSourceModuleFiles,
  computeJobsSeoEmitterFingerprints,
  JOBS_SEO_FINGERPRINT_INERT_MODULES,
  createJobsSeoHtmlReuse,
  diagnoseHtmlReuseMismatch,
  htmlHasIndexableRobots,
  htmlReusePackIndexPath,
  htmlReusePackPath,
  htmlReuseCachePath,
  JOBS_SEO_HTML_PACK_VERSION,
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

function writeCachedHtml(rootDir: string, pagePath: string, kind: string, input: unknown, html: string) {
  const inputHash = computeInputHash(input, kind);
  const file = htmlReuseCachePath(rootDir, 'it', pagePath, null, kind, inputHash);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, html);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, '<html>old-emitter</html>');
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
      writeCachedHtml(rootDir, pagePath, 'active-job', { value: 'old' }, '<html>old</html>');
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', { value: 'new' }, 'active');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>new</html>');
      expect(reuse.summary().active).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'input-hash-changed': 1 },
      });
      writePreviousManifest(rootDir, pagePath, 'active-job', { value: 'new' });
      const reread = await createReuse(rootDir);
      expect(reread.lookup('it', pagePath, 'active-job', { value: 'new' }, 'active').html)
        .toBe('<html>new</html>');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['sourceInputHash', null],
    ['sourceInputHash', ''],
    ['canonicalInputHash', null],
    ['canonicalInputHash', ''],
  ])(
    'does not reuse a bridge when %s=%s is unavailable',
    async (sourceHashKey, sourceHashValue) => {
      const rootDir = fixtureRoot();
      const pagePath = '/cerca-lavoro-ticino/unresolved-source/';
      const input = {
        source: 'active-job',
        [sourceHashKey]: sourceHashValue,
        jobId: 'job-1',
        path: pagePath,
      };
      try {
        writePreviousManifest(rootDir, pagePath, 'cross-locale-reconciliation', input);
        writeCachedHtml(rootDir, pagePath, 'cross-locale-reconciliation', input, '<html>stale-source</html>');
        const reuse = await createReuse(rootDir);
        const candidate = reuse.lookup(
          'it',
          pagePath,
          'cross-locale-reconciliation',
          input,
          'cross-locale-reconciliation',
        );
        expect(candidate).toMatchObject({ hit: false, html: null, cacheable: false });
        reuse.finish(candidate, '<html>fresh-source</html>');
        expect(reuse.summary()['cross-locale-reconciliation']).toMatchObject({
          rendered: 1,
          reused: 0,
          missReasons: { 'input-unavailable': 1 },
        });
        expect(fs.existsSync(candidate.cachePath)).toBe(false);
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    },
  );

  it('keeps same-path HTML variants separate by kind and input hash', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/shared-variant/';
    const oldInput = { value: 'old' };
    const newInput = { value: 'new' };
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', oldInput);
      writeCachedHtml(rootDir, pagePath, 'active-job', oldInput, '<html>old</html>');

      const reuse = await createReuse(rootDir);
      const oldCandidate = reuse.lookup('it', pagePath, 'active-job', oldInput, 'active');
      expect(oldCandidate.hit).toBe(true);
      reuse.finish(oldCandidate, '<html>old</html>');

      const newCandidate = reuse.lookup('it', pagePath, 'active-job', newInput, 'active');
      expect(newCandidate.hit).toBe(false);
      reuse.finish(newCandidate, '<html>new</html>');

      writePreviousManifest(rootDir, pagePath, 'active-job', oldInput);
      const oldRead = await createReuse(rootDir);
      expect(oldRead.lookup('it', pagePath, 'active-job', oldInput, 'active').html)
        .toBe('<html>old</html>');
      writePreviousManifest(rootDir, pagePath, 'active-job', newInput);
      const newRead = await createReuse(rootDir);
      expect(newRead.lookup('it', pagePath, 'active-job', newInput, 'active').html)
        .toBe('<html>new</html>');
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

  it('round-trips HTML through a locale/block pack and index', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/pack-round-trip/';
    const input = { value: 'pack' };
    const html = '<html><body>pack round-trip</body></html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      expect(candidate.hit).toBe(false);
      reuse.finish(candidate, html);
      expect(fs.existsSync(htmlReusePackPath(rootDir, 'it', 'active'))).toBe(true);
      expect(fs.existsSync(htmlReusePackIndexPath(rootDir, 'it', 'active'))).toBe(true);
      expect(fs.readdirSync(path.join(rootDir, '.cache', 'incremental-html', 'it')))
        .not.toContain(expect.stringMatching(/\.html$/u));

      const reread = await createReuse(rootDir);
      const rereadCandidate = reread.lookup('it', pagePath, 'active-job', input, 'active');
      expect(rereadCandidate).toMatchObject({ hit: true, html });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('promotes a legacy entry to the pack and prunes the old file', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/pack-migration/';
    const input = { value: 'migration' };
    const legacyPath = htmlReuseCachePath(
      rootDir,
      'it',
      pagePath,
      null,
      'active-job',
      computeInputHash(input, 'active-job'),
    );
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, 'active-job', input, '<html>legacy</html>');
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      expect(candidate).toMatchObject({ hit: true, storage: 'legacy' });
      reuse.finish(candidate, candidate.html);
      reuse.prune('it', {
        entries: new Map([[pagePath, {
          kind: 'active-job',
          inputHash: computeInputHash(input, 'active-job'),
        }]]),
      });
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(htmlReusePackPath(rootDir, 'it', 'active'))).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats a truncated pack payload as a clean cache miss', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/pack-truncated/';
    const input = { value: 'truncated' };
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      reuse.finish(candidate, '<html>truncated payload</html>');
      const packPath = htmlReusePackPath(rootDir, 'it', 'active');
      fs.truncateSync(packPath, fs.statSync(packPath).size - 1);

      const reread = await createReuse(rootDir);
      const truncated = reread.lookup('it', pagePath, 'active-job', input, 'active');
      expect(truncated).toMatchObject({ hit: false, html: null });
      expect(reread.summary().active.missReasons).toMatchObject({ 'html-unavailable': 1 });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('ignores a pack with an unknown version', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/pack-version/';
    const input = { value: 'version' };
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      reuse.finish(candidate, '<html>unknown version</html>');
      const packPath = htmlReusePackPath(rootDir, 'it', 'active');
      const lines = fs.readFileSync(packPath, 'utf8').split('\n');
      const header = JSON.parse(lines[0]);
      header.version = `${JOBS_SEO_HTML_PACK_VERSION}-unknown`;
      lines[0] = JSON.stringify(header);
      fs.writeFileSync(packPath, lines.join('\n'), 'utf8');

      const reread = await createReuse(rootDir);
      const unknown = reread.lookup('it', pagePath, 'active-job', input, 'active');
      expect(unknown).toMatchObject({ hit: false, html: null });
      expect(reread.summary().active.missReasons).toMatchObject({ 'html-unavailable': 1 });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('compacts overwritten entries once a pack exceeds twice its live bytes', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/pack-compact/';
    const input = { value: 'compact' };
    const liveHtml = '<html>' + 'x'.repeat(4096) + '</html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      const seed = await createReuse(rootDir);
      const seedCandidate = seed.lookup('it', pagePath, 'active-job', input, 'active');
      seed.finish(seedCandidate, liveHtml);

      const verify = await createReuse(rootDir, true);
      for (let index = 0; index < 4; index += 1) {
        const candidate = verify.lookup('it', pagePath, 'active-job', input, 'active');
        expect(candidate).toMatchObject({ hit: true, verify: true });
        verify.finish(candidate, `${liveHtml}${index}`);
      }
      const packPath = htmlReusePackPath(rootDir, 'it', 'active');
      const before = fs.statSync(packPath).size;
      verify.prune('it', {
        entries: new Map([[pagePath, {
          kind: 'active-job',
          inputHash: computeInputHash(input, 'active-job'),
        }]]),
      });
      const after = fs.statSync(packPath).size;
      expect(after).toBeLessThan(before);
      expect((await createReuse(rootDir)).lookup('it', pagePath, 'active-job', input, 'active').hit)
        .toBe(true);
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
      writeCachedHtml(rootDir, pagePath, 'expired-soft-landing', input, html);
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
      writeCachedHtml(rootDir, pagePath, 'cross-locale-reconciliation', input, previousHtml);
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

  it('keeps the emitter fingerprint stable when cache storage changes', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        'import "./shared/incrementalHtmlReuse.mjs";\nexport const renderVersion = "v1";\n',
      );
      writeFixtureFile(
        rootDir,
        'build-plugins/shared/incrementalHtmlReuse.mjs',
        'export const storageVersion = "v1";\n',
      );
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(
        rootDir,
        'build-plugins/shared/incrementalHtmlReuse.mjs',
        'export const storageVersion = "v2";\n',
      );
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, previousHtml);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, previousHtml);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, previousHtml);
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
      writeCachedHtml(rootDir, pagePath, 'active-job', input, html);
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

  it('ignores type-only imports and imports quoted inside comments', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        [
          "import type { JobListing } from '../components/community/JobBoard';",
          "export type { Spa } from '../components/community/JobBoard';",
          "// NOT a static `import … from '@/data/job-popularity.json'` here.",
          ' * import x from "../components/community/JobBoard";',
          'export const renderVersion = "v1";',
          '',
        ].join('\n'),
      );
      writeFixtureFile(rootDir, 'components/community/JobBoard.tsx', 'export const spa = "v1";\n');
      writeFixtureFile(rootDir, 'data/job-popularity.json', '{"v":1}\n');
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      expect(collectSourceModuleFiles(rootDir, ['build-plugins/jobsSeoPagesPlugin.ts']))
        .toEqual(['build-plugins/jobsSeoPagesPlugin.ts']);
      writeFixtureFile(rootDir, 'components/community/JobBoard.tsx', 'export const spa = "v2";\n');
      writeFixtureFile(rootDir, 'data/job-popularity.json', '{"v":2}\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('changes the emitter fingerprint when a template module imported by value changes', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        [
          "import type { Shape } from './shared/jobDetailHtml/types';",
          "import { renderHero, type Hero } from './shared/jobDetailHtml/hero';",
          'const a = 1; import { footer } from "./shared/footer";',
          'export const renderVersion = "v1";',
          '',
        ].join('\n'),
      );
      writeFixtureFile(rootDir, 'build-plugins/shared/jobDetailHtml/types.ts', 'export type Shape = 1;\n');
      writeFixtureFile(rootDir, 'build-plugins/shared/jobDetailHtml/hero.ts', 'export const renderHero = () => "<h1>";\n');
      writeFixtureFile(rootDir, 'build-plugins/shared/footer.ts', 'export const footer = "<footer>";\n');
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'build-plugins/shared/jobDetailHtml/types.ts', 'export type Shape = 2;\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);
      writeFixtureFile(rootDir, 'build-plugins/shared/jobDetailHtml/hero.ts', 'export const renderHero = () => "<h2>";\n');
      const afterHero = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      expect(afterHero).not.toBe(before);
      writeFixtureFile(rootDir, 'build-plugins/shared/footer.ts', 'export const footer = "<footer class=x>";\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(afterHero);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps imports that follow or contain a comment in the render graph', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        [
          "/* banner */ import { a } from './shared/a';",
          "import /* inline */ { b } from './shared/b';",
          "import {",
          "  c, // trailing 'quoted' note",
          "} from './shared/c';",
          "export /* re-export */ { d } from './shared/d';",
          'export const renderVersion = "v1";',
          '',
        ].join('\n'),
      );
      for (const name of ['a', 'b', 'c', 'd']) {
        writeFixtureFile(rootDir, `build-plugins/shared/${name}.ts`, `export const ${name} = 1;\n`);
      }
      expect(collectSourceModuleFiles(rootDir, ['build-plugins/jobsSeoPagesPlugin.ts'])).toEqual([
        'build-plugins/jobsSeoPagesPlugin.ts',
        'build-plugins/shared/a.ts',
        'build-plugins/shared/b.ts',
        'build-plugins/shared/c.ts',
        'build-plugins/shared/d.ts',
      ]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('prunes an inert module only while every importer is on its allowlist', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        "import { borderCrossings } from '../data/borderCrossings';\nexport const renderVersion = \"v1\";\n",
      );
      writeFixtureFile(
        rootDir,
        'data/borderCrossings.ts',
        "import averages from './border-wait-averages.json' with { type: 'json' };\nexport const borderCrossings = [averages];\n",
      );
      writeFixtureFile(rootDir, 'data/border-wait-averages.json', '{"chiasso":{"morning":"10 min"}}\n');
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'data/border-wait-averages.json', '{"chiasso":{"morning":"25 min"}}\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);

      // A second, unlisted consumer makes the same data a render input again.
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        [
          "import { borderCrossings } from '../data/borderCrossings';",
          "import averages from '../data/border-wait-averages.json';",
          'export const renderVersion = "v1";',
          '',
        ].join('\n'),
      );
      expect(collectSourceModuleFiles(
        rootDir,
        ['build-plugins/jobsSeoPagesPlugin.ts'],
        JOBS_SEO_FINGERPRINT_INERT_MODULES,
      )).toContain('data/border-wait-averages.json');
      const withConsumer = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'data/border-wait-averages.json', '{"chiasso":{"morning":"40 min"}}\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(withConsumer);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps the inert-module rationale true for the real render graph', () => {
    // data/border-wait-averages.json is inert only while the job renderer reads
    // no wait average from borderCrossings; free-translate.mjs only while the
    // renderer imports no translator from events-utils.mjs.
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const snapshot = fs.readFileSync(path.join(repoRoot, 'services/jobLocationSnapshot.ts'), 'utf8');
    expect(snapshot).not.toMatch(/avgWait/);
    const crosslink = fs.readFileSync(path.join(repoRoot, 'build-plugins/shared/jobEventsCrosslink.ts'), 'utf8');
    const eventsImport = crosslink.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*events-utils\.mjs['"]/);
    expect(eventsImport?.[1]).toBeDefined();
    expect(eventsImport?.[1]).not.toMatch(/[Tt]ranslat/);
    expect(Object.keys(JOBS_SEO_FINGERPRINT_INERT_MODULES).sort()).toEqual([
      'build-plugins/batchWrite.ts',
      'build-plugins/shared/buildMemLog.ts',
      'build-plugins/shared/forceGc.ts',
      'build-plugins/shared/incrementalManifest.mjs',
      'build-plugins/shared/jobsSeoProfiler.ts',
      'build-plugins/sharedWriteRegistry.ts',
      'data/border-wait-averages.json',
      'scripts/lib/free-translate.mjs',
    ]);
  });

  it('keeps the deploy I/O and telemetry modules out of the real render graph', () => {
    // WriteCollector must write the string it receives: no reassignment of
    // `content` and no string rewrite anywhere in batchWrite.ts.
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const read = (relativeFile: string) => fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8');
    const batchWrite = read('build-plugins/batchWrite.ts');
    expect(batchWrite).not.toMatch(/\bcontent\s*=[^=>]/);
    expect(batchWrite).not.toMatch(/\bcontent\s*\.\s*(?:replace|replaceAll|slice|substring|trim)\b/);
    const plugin = read('build-plugins/jobsSeoPagesPlugin.ts');
    // The renderer reads only the size of the registry history (memory log).
    expect(plugin.match(/getPathHistory\(\)[^\n]*/g)).toEqual(['getPathHistory().size,']);
    // No pass-through profiler wrapper wraps a render call.
    const profilerImport = plugin.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/shared\/jobsSeoProfiler(?:\.ts)?['"]/);
    expect(profilerImport?.[1]).toBeDefined();
    expect(profilerImport?.[1]).not.toMatch(/\btimed\b/);
    // From the incremental manifest the renderer takes only manifest/digest
    // plumbing; a render-time helper imported from it would be a render input.
    const manifestImport = plugin.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/shared\/incrementalManifest\.mjs['"]/);
    expect(manifestImport?.[1].split(',').map((name) => name.trim()).filter(Boolean).sort()).toEqual([
      'INCREMENTAL_MANIFEST_ENABLED',
      'buildMinimalJobInput',
      'getIncrementalManifestInputCache',
      'getIncrementalManifestMap',
      'logIncrementalManifestMemory',
      'resetIncrementalManifestInputCache',
    ]);

    const graph = collectSourceModuleFiles(
      repoRoot,
      ['build-plugins/jobsSeoPagesPlugin.ts'],
      JOBS_SEO_FINGERPRINT_INERT_MODULES,
    );
    for (const inert of [
      'build-plugins/batchWrite.ts',
      'build-plugins/contentHash.ts',
      'build-plugins/shared/buildMemLog.ts',
      'build-plugins/shared/forceGc.ts',
      'build-plugins/shared/incrementalManifest.mjs',
      'build-plugins/shared/jobsSeoProfiler.ts',
      'build-plugins/shared/postWalkDerivedDigest.ts',
      'build-plugins/sharedWriteRegistry.ts',
    ]) {
      expect(graph).not.toContain(inert);
    }
    for (const renderModule of [
      'build-plugins/jobsSeoPagesPlugin.ts',
      'build-plugins/htmlTemplate.ts',
      'build-plugins/shared/jobDetailHtml/index.ts',
      'build-plugins/shared/jobPostingSchema.ts',
      'build-plugins/shared/localeEmitFilter.ts',
      'build-plugins/shared/stableJobId.mjs',
    ]) {
      expect(graph).toContain(renderModule);
    }
  });

  it('ignores a write-path edit but not a template edit, until an unlisted module imports the writer', () => {
    const rootDir = fingerprintFixtureRoot();
    try {
      writeFixtureFile(
        rootDir,
        'build-plugins/jobsSeoPagesPlugin.ts',
        [
          "import { WriteCollector } from './batchWrite';",
          "import { logBuildMem } from './shared/buildMemLog';",
          "import { renderJobCardHtml } from './shared/jobCardHtml';",
          'export const renderVersion = "v1";',
          '',
        ].join('\n'),
      );
      writeFixtureFile(rootDir, 'build-plugins/batchWrite.ts', "import { claim } from './sharedWriteRegistry';\nexport class WriteCollector {}\n");
      writeFixtureFile(rootDir, 'build-plugins/sharedWriteRegistry.ts', 'export const claim = () => "accepted";\n');
      writeFixtureFile(rootDir, 'build-plugins/shared/buildMemLog.ts', "import { forceGc } from './forceGc';\nexport const logBuildMem = () => ({ gcFreed: 0 });\n");
      writeFixtureFile(rootDir, 'build-plugins/shared/forceGc.ts', 'export const forceGc = () => true;\n');
      writeFixtureFile(rootDir, 'build-plugins/shared/jobCardHtml.ts', 'export const renderJobCardHtml = () => "<li>v1</li>";\n');
      clearFingerprintEnv();
      const before = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];

      writeFixtureFile(rootDir, 'build-plugins/batchWrite.ts', "import { claim } from './sharedWriteRegistry';\nexport class WriteCollector { flushEvery = 64; }\n");
      writeFixtureFile(rootDir, 'build-plugins/sharedWriteRegistry.ts', 'export const claim = () => "accepted-v2";\n');
      writeFixtureFile(rootDir, 'build-plugins/shared/buildMemLog.ts', "import { forceGc } from './forceGc';\nexport const logBuildMem = () => ({ gcFreed: 1 });\n");
      writeFixtureFile(rootDir, 'build-plugins/shared/forceGc.ts', 'export const forceGc = () => false;\n');
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).toBe(before);

      writeFixtureFile(rootDir, 'build-plugins/shared/jobCardHtml.ts', 'export const renderJobCardHtml = () => "<li>v2</li>";\n');
      const afterTemplate = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      expect(afterTemplate).not.toBe(before);

      // A template that starts importing the writer makes it a render input.
      writeFixtureFile(
        rootDir,
        'build-plugins/shared/jobCardHtml.ts',
        "import { WriteCollector } from '../batchWrite';\nexport const renderJobCardHtml = () => `<li>${WriteCollector.name}</li>`;\n",
      );
      expect(collectSourceModuleFiles(
        rootDir,
        ['build-plugins/jobsSeoPagesPlugin.ts'],
        JOBS_SEO_FINGERPRINT_INERT_MODULES,
      )).toEqual(expect.arrayContaining(['build-plugins/batchWrite.ts', 'build-plugins/sharedWriteRegistry.ts']));
      const withConsumer = computeJobsSeoEmitterFingerprints(rootDir)['active-job'];
      writeFixtureFile(rootDir, 'build-plugins/batchWrite.ts', "import { claim } from './sharedWriteRegistry';\nexport class WriteCollector { flushEvery = 128; }\n");
      expect(computeJobsSeoEmitterFingerprints(rootDir)['active-job']).not.toBe(withConsumer);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
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
