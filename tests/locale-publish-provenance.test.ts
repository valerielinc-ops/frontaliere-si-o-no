import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  createLocalePublishProvenance,
  validateLocalePublishProvenance,
  validateLocaleSourceProvenance,
} from '../scripts/ci/locale-publish-provenance.mjs';
import { resolveLocalePublishPlan } from '../scripts/ci/resolve-locale-publish-plan.mjs';
import { resolveNonItPublishPlan } from '../scripts/ci/resolve-nonit-publish-plan.mjs';
import {
  localeHomeUrl,
  validateLocaleHomes,
} from '../scripts/ci/validate-locale-publish-live.mjs';

const SOURCE_RUN_ID = '36850086638';
const SOURCE_SHA = 'a'.repeat(40);
const BUILD_ID = '1770000000000';
const tempDirs: string[] = [];

function tempDist(buildId = BUILD_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-publish-provenance-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'build-id.txt'), `${buildId}\n`);
  return dir;
}

function jobs(overrides: Record<string, string> = {}) {
  const conclusions = { it: 'success', en: 'success', de: 'success', fr: 'success', ...overrides };
  return {
    jobs: [
      { name: 'validate production promotion trigger', conclusion: 'success' },
      { name: 'matrix-setup', conclusion: 'success' },
      { name: 'prep', conclusion: 'success' },
      ...(['it', 'en', 'de', 'fr'] as const).map((locale) => ({
        name: `build-locale (${locale})`,
        conclusion: conclusions[locale],
      })),
    ],
  };
}

function receipt(locale: 'it' | 'en' | 'de' | 'fr', buildId = BUILD_ID) {
  const outcomes = locale === 'it'
    ? { build: 'success', validate: 'success', itPrep: 'success', pagesArtifact: 'success' }
    : {
      build: 'success',
      validate: 'success',
      offload: 'success',
      sectionPush: 'success',
      cdnGate: 'success',
      localePush: 'success',
      localePack: 'success',
      localeArtifact: 'success',
      tailBudget: 'success',
    };
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-publish-runner-'));
  tempDirs.push(runnerTemp);
  if (locale !== 'it') fs.writeFileSync(path.join(runnerTemp, `shard-ok-${locale}`), '');
  return createLocalePublishProvenance({
    locale,
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    deployBuildId: buildId,
    distDir: tempDist(buildId),
    runnerTemp,
    outcomes,
  });
}

function manifests(...locales: Array<'it' | 'en' | 'de' | 'fr'>) {
  return locales.map((locale) => ({ file: `${locale}.json`, manifest: receipt(locale) }));
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('locale publish provenance', () => {
  it('requires every critical IT step and records a coherent CDN id', () => {
    const manifest = receipt('it');
    expect(manifest.published).toBe(true);
    expect(manifest.payloadStatus).toBe('complete');
    expect(manifest.cdnBuildId).toBe(BUILD_ID);
    expect(manifest.cdnStatus).toBe('coherent');
    expect(validateLocalePublishProvenance(manifest, {
      locale: 'it',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      expectedBuildId: BUILD_ID,
    }).valid).toBe(true);
  });

  it('marks a failed non-IT leg stale instead of advertising a partial payload', () => {
    const manifest = createLocalePublishProvenance({
      locale: 'en',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      deployBuildId: BUILD_ID,
      distDir: tempDist(),
      outcomes: { build: 'failure' },
    });
    expect(manifest.published).toBe(false);
    expect(manifest.stale).toBe(true);
    expect(manifest.fallback).toBe('last-known-good');
    expect(manifest.reasons).toContain('build outcome is "failure"');
  });

  it('marks a validated non-IT source artifact ready for the deferred tail', () => {
    const manifest = createLocalePublishProvenance({
      locale: 'en',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      deployBuildId: BUILD_ID,
      artifactRunId: SOURCE_RUN_ID,
      distDir: tempDist(),
      outcomes: { build: 'success', validate: 'success', sourceArtifact: 'success' },
    });
    expect(manifest.payloadStatus).toBe('source-ready');
    expect(manifest.publishStatus).toBe('ready-for-tail');
    expect(manifest.artifactName).toBe(`locale-shard-source-en-${SOURCE_RUN_ID}`);
    expect(validateLocaleSourceProvenance(manifest, {
      locale: 'en',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      expectedBuildId: BUILD_ID,
      expectedArtifactRunId: SOURCE_RUN_ID,
    }).valid).toBe(true);
  });

  it('does not call a skipped shard push a successful publish', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-publish-runner-'));
    tempDirs.push(runnerTemp);
    const manifest = createLocalePublishProvenance({
      locale: 'fr',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      deployBuildId: BUILD_ID,
      distDir: tempDist(),
      runnerTemp,
      outcomes: {
        build: 'success',
        validate: 'success',
        offload: 'success',
        sectionPush: 'success',
        cdnGate: 'success',
        localePush: 'success',
        localePack: 'success',
        localeArtifact: 'success',
        tailBudget: 'success',
      },
    });
    expect(manifest.published).toBe(false);
    expect(manifest.reasons).toContain('locale shard success marker is missing');
  });

  it('rejects a build-id mismatch between the leg and its shared deploy id', () => {
    const manifest = receipt('de', '1770000000001');
    expect(manifest.published).toBe(true);
    expect(validateLocalePublishProvenance(manifest, { expectedBuildId: BUILD_ID }).valid).toBe(false);
  });
});

describe('locale publish admission plan', () => {
  it('publishes all proven locales for a green run', () => {
    const plan = resolveLocalePublishPlan({
      runConclusion: 'success',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: jobs(),
      provenance: manifests('it', 'en', 'de', 'fr'),
    });
    expect(plan).toMatchObject({
      allowed: true,
      mode: 'full',
      buildId: BUILD_ID,
      healthyLocales: ['it', 'en', 'de', 'fr'],
      staleLocales: [],
    });
  });

  it('publishes healthy locales when one matrix leg is cancelled and declares it stale', () => {
    const plan = resolveLocalePublishPlan({
      runConclusion: 'cancelled',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: jobs({ en: 'cancelled' }),
      provenance: manifests('it', 'de', 'fr'),
    });
    expect(plan.allowed).toBe(true);
    expect(plan.mode).toBe('partial');
    expect(plan.healthyLocales).toEqual(['it', 'de', 'fr']);
    expect(plan.staleLocales).toEqual(['en']);
    expect(plan.staleReasons.en).toContain('source job concluded cancelled');
    expect(plan.reason).toContain('stale fallback for en');
  });

  it('hands source-ready non-IT locales to the post-build tail', () => {
    const source = createLocalePublishProvenance({
      locale: 'en',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      deployBuildId: BUILD_ID,
      artifactRunId: SOURCE_RUN_ID,
      distDir: tempDist(),
      outcomes: { build: 'success', validate: 'success', sourceArtifact: 'success' },
    });
    const plan = resolveLocalePublishPlan({
      runConclusion: 'success',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: jobs({ de: 'failure', fr: 'failure' }),
      provenance: [
        { file: 'it.json', manifest: receipt('it') },
        { file: 'en.json', manifest: source },
      ],
    });
    expect(plan.allowed).toBe(true);
    expect(plan.healthyLocales).toEqual(['it']);
    expect(plan.tailLocales).toEqual(['en']);
    expect(plan.staleLocales).toEqual(['en', 'de', 'fr']);
  });

  it('does not publish around a failed IT leg even when other locales are proven', () => {
    const plan = resolveLocalePublishPlan({
      runConclusion: 'failure',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: jobs({ it: 'failure' }),
      provenance: manifests('en', 'de', 'fr'),
    });
    expect(plan.allowed).toBe(false);
    expect(plan.mode).toBe('blocked');
    expect(plan.healthyLocales).toEqual([]);
    expect(plan.reason).toContain('IT locale is not a successful source job');
  });

  it('keeps a successful locale stale when its provenance receipt is missing', () => {
    const plan = resolveLocalePublishPlan({
      runConclusion: 'failure',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: jobs({ en: 'failure' }),
      provenance: manifests('it', 'fr'),
    });
    expect(plan.allowed).toBe(true);
    expect(plan.healthyLocales).toEqual(['it', 'fr']);
    expect(plan.staleLocales).toEqual(['en', 'de']);
    expect(plan.staleReasons.de).toContain('no provenance receipt');
  });

  it('fails closed when a prerequisite is not successful', () => {
    const sourceJobs = jobs();
    sourceJobs.jobs.find((job) => job.name === 'prep')!.conclusion = 'failure';
    const plan = resolveLocalePublishPlan({
      runConclusion: 'failure',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      jobs: sourceJobs,
      provenance: manifests('it', 'en', 'de', 'fr'),
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toContain('prep conclusion is "failure"');
  });

  it('promotes only a complete post-build receipt into the healthy set', () => {
    const plan = resolveNonItPublishPlan({
      sourceHealthyLocales: ['it'],
      sourceStaleLocales: ['en', 'de', 'fr'],
      tailLocales: ['en'],
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      expectedBuildId: BUILD_ID,
      artifactRunId: '36850086639',
      provenance: [{
        file: 'en.json',
        manifest: {
          ...receipt('en'),
          sourceRunId: SOURCE_RUN_ID,
          artifactRunId: '36850086639',
          artifactName: 'locale-dist-en-36850086639',
        },
      }],
    });
    expect(plan.allowed).toBe(true);
    expect(plan.healthyLocales).toEqual(['it', 'en']);
    expect(plan.staleLocales).toEqual(['de', 'fr']);
    expect(plan.readyLocales).toEqual(['en']);
  });
});

describe('locale publish workflow wiring', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const deploy = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8')) as any;
  const publish = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy-publish.yml'), 'utf8')) as any;
  const localeSteps = deploy.jobs['build-locale'].steps as Array<Record<string, any>>;
  const provenanceSource = fs.readFileSync(path.join(root, 'scripts/ci/locale-publish-provenance.mjs'), 'utf8');

  it('emits and uploads one receipt per matrix leg after all publish-critical steps', () => {
    const write = localeSteps.find((step) => step.name === 'Write locale publish provenance');
    const upload = localeSteps.find((step) => step.name === 'Upload locale publish provenance');
    const cache = localeSteps.find((step) => step.name === 'Save incremental manifest cache');
    expect(write?.if).toBe('always()');
    expect(String(write?.run)).toContain('locale-publish-provenance.mjs');
    expect(upload?.uses).toBe('actions/upload-artifact@v7');
    expect(upload?.with?.name).toContain('locale-publish-provenance-');
    expect(localeSteps.indexOf(write!)).toBeLessThan(localeSteps.indexOf(cache!));
  });

  it('routes publish through the plan and keeps missing IT provenance fail-closed', () => {
    const resolver = publish.jobs['resolve-publish-plan'];
    const deployJob = publish.jobs.deploy;
    const validateDist = publish.jobs['validate-dist'];
    expect(resolver).toBeDefined();
    expect(resolver.outputs.allowed).toContain('steps.plan.outputs.allowed');
    expect(deployJob.needs).toBe('resolve-publish-plan');
    expect(String(deployJob.if)).toContain('outputs.allowed');
    expect(String(deployJob.if)).toContain("needs.resolve-publish-plan.outputs.it_admitted == 'true'");
    expect(String(deployJob.if)).not.toContain('workflow_run.conclusion');
    expect(validateDist.needs).toEqual(['resolve-publish-plan', 'resolve-nonit-publish']);
    expect(validateDist.with.shard_artifact_run_id).toContain('github.run_id');
    expect(publish.jobs['resolve-nonit-publish'].needs).toEqual(['resolve-publish-plan', 'publish-nonit-shards']);
    const tailJob = publish.jobs['publish-nonit-shards'];
    expect(String(tailJob.strategy.matrix.locale)).toContain(
      'fromJSON(needs.resolve-publish-plan.outputs.tail_locales)',
    );
    expect(String(tailJob.if)).not.toContain('matrix.locale');
    expect(publish.jobs['validate-live'].needs).toEqual(['resolve-publish-plan', 'resolve-nonit-publish', 'deploy']);
    expect(publish.jobs['validate-live'].with.healthy_locales).toContain('resolve-nonit-publish');
    const recheck = (deployJob.steps as Array<Record<string, any>>)
      .find((step) => step.name === 'Enforce IT provenance identity');
    expect(String(recheck?.run)).toContain('--validate-dir');
  });

  it('records the deferred tail budget outcome in the final receipt', () => {
    expect(provenanceSource).toContain('tailBudget: process.env.PROVENANCE_TAIL_BUDGET_OUTCOME');
  });
});

describe('locale live smoke observer', () => {
  it('uses the canonical trailing-slash home for IT and each shard locale', () => {
    expect(localeHomeUrl('https://frontaliereticino.ch/', 'it')).toBe('https://frontaliereticino.ch/');
    expect(localeHomeUrl('https://frontaliereticino.ch/', 'en')).toBe('https://frontaliereticino.ch/en/');
  });

  it('checks healthy publishes and declared stale fallbacks together', async () => {
    const calls: string[] = [];
    const verdict = await validateLocaleHomes({
      baseUrl: 'https://example.test',
      healthyLocales: ['it', 'de'],
      staleLocales: ['en'],
      attempts: 1,
      intervalMs: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        return { status: 200 } as Response;
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.entries.map((entry) => [entry.locale, entry.classification])).toEqual([
      ['it', 'healthy-publish'],
      ['de', 'healthy-publish'],
      ['en', 'stale-fallback'],
    ]);
    expect(calls).toEqual([
      'https://example.test/',
      'https://example.test/de/',
      'https://example.test/en/',
    ]);
  });
});
