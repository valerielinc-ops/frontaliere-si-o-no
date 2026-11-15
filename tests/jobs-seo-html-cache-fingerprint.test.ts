import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
} from '../build-plugins/shared/incrementalManifest.mjs';
import {
  computeJobsSeoHtmlCacheFingerprint,
} from '../build-plugins/shared/incrementalHtmlReuse.mjs';
import {
  resolveJobsSeoHtmlCacheFingerprintOutputs,
} from '../scripts/ci/jobs-seo-html-cache-fingerprint.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_WORKFLOW = resolve(ROOT, '.github/workflows/deploy.yml');
const temporaryRoots: string[] = [];

function makeRepoRoot(
  locale: string,
  previousFingerprints?: Record<string, string>,
  manifestLocale = locale,
): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'jobs-seo-html-cache-fingerprint-'));
  temporaryRoots.push(repoRoot);
  if (previousFingerprints) {
    const manifestDir = join(repoRoot, '.cache', 'incremental-manifest');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, `${locale}.jsonl`),
      `${JSON.stringify({
        type: 'header',
        manifestVersion: MANIFEST_VERSION,
        format: MANIFEST_FORMAT,
        locale: manifestLocale,
        jobsSeoEmitterFingerprint: previousFingerprints,
      })}\n`,
      'utf8',
    );
  }
  return repoRoot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('jobs SEO HTML cache fingerprints', () => {
  const currentFingerprints = {
    'active-job': 'renderer-active-current',
    'expired-soft-landing': 'renderer-expired-current',
  };
  const previousFingerprints = {
    'active-job': 'renderer-active-previous',
    'expired-soft-landing': 'renderer-expired-previous',
  };

  it('restores the exact previous renderer cache when output probing is enabled', () => {
    const repoRoot = makeRepoRoot('it', previousFingerprints);
    const result = resolveJobsSeoHtmlCacheFingerprintOutputs({
      repoRoot,
      locale: 'it',
      currentFingerprints,
      probeEnabled: true,
    });

    expect(result.fingerprint).toBe(computeJobsSeoHtmlCacheFingerprint(currentFingerprints));
    expect(result.restore_fingerprint).toBe(computeJobsSeoHtmlCacheFingerprint(previousFingerprints));
    expect(result.restore_source).toBe('previous-manifest');
  });

  it('uses the current renderer key when probing is disabled or previous metadata is unusable', () => {
    const previousRepoRoot = makeRepoRoot('it', previousFingerprints);
    const disabled = resolveJobsSeoHtmlCacheFingerprintOutputs({
      repoRoot: previousRepoRoot,
      locale: 'it',
      currentFingerprints,
      probeEnabled: false,
    });
    expect(disabled.restore_fingerprint).toBe(disabled.fingerprint);
    expect(disabled.restore_source).toBe('current');

    const missingRepoRoot = makeRepoRoot('it');
    const missing = resolveJobsSeoHtmlCacheFingerprintOutputs({
      repoRoot: missingRepoRoot,
      locale: 'it',
      currentFingerprints,
      probeEnabled: true,
    });
    expect(missing.restore_fingerprint).toBe(missing.fingerprint);
    expect(missing.restore_source).toBe('current');

    const wrongLocaleRepoRoot = makeRepoRoot('it', previousFingerprints, 'fr');
    const wrongLocale = resolveJobsSeoHtmlCacheFingerprintOutputs({
      repoRoot: wrongLocaleRepoRoot,
      locale: 'it',
      currentFingerprints,
      probeEnabled: true,
    });
    expect(wrongLocale.restore_fingerprint).toBe(wrongLocale.fingerprint);
    expect(wrongLocale.restore_source).toBe('current');
  });

  it('restores with the previous manifest fingerprint but saves with the current fingerprint', () => {
    const workflow = YAML.parse(readFileSync(DEPLOY_WORKFLOW, 'utf8')) as any;
    const steps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;
    const fingerprint = steps.find((step) => step.id === 'jobs-seo-html-fingerprint');
    const restore = steps.find((step) => step.id === 'jobs-seo-html-cache');
    const save = steps.find((step) => step.name === 'Save jobs SEO HTML cache');
    const barrierSave = steps.find((step) => step.name === 'Save jobs SEO HTML cache after hreflang barrier failure');
    const observer = steps.find((step) => step.id === 'jobs-seo-cache-hit-observer');

    expect(fingerprint.env.JOBS_SEO_HTML_CACHE_LOCALE).toBe('${{ matrix.locale }}');
    expect(restore.with.key).toContain("hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale))");
    expect(restore.with.key).toContain('steps.jobs-seo-html-fingerprint.outputs.restore_fingerprint');
    expect(restore.with).not.toHaveProperty('restore-keys');
    expect(save.with.key).toContain('steps.jobs-seo-html-fingerprint.outputs.fingerprint');
    expect(barrierSave.with.key).toContain('steps.jobs-seo-html-fingerprint.outputs.fingerprint');
    expect(save.id).toBe('jobs-seo-html-save');
    expect(barrierSave.id).toBe('jobs-seo-html-barrier-save');
    expect(observer.if).toBe('always()');
    expect(observer['continue-on-error']).toBe(true);
    expect(observer.env.JOBS_SEO_CACHE_HIT).toContain('steps.jobs-seo-html-cache.outputs.cache-hit');
    expect(observer.env.JOBS_SEO_CACHE_MATCHED_KEY).toContain('steps.jobs-seo-html-cache.outputs.cache-matched-key');
    expect(observer.env.JOBS_SEO_BUILD_WALL_SECONDS).toContain('steps.build_step.outputs.wall_seconds');
    expect(observer.run).toContain('jobsSeoCacheHit()');
    expect(observer.run).toContain('^\\[jobs-seo-reuse\\] block=');
    expect(observer.run).toContain('unknown');
  });
});
