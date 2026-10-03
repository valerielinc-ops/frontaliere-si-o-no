import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalePublishProvenance,
  validateLocalePublishProvenance,
} from '../scripts/ci/locale-publish-provenance.mjs';
import { resolveLocalePublishPlan } from '../scripts/ci/resolve-locale-publish-plan.mjs';

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
    };
  return createLocalePublishProvenance({
    locale,
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    deployBuildId: buildId,
    distDir: tempDist(buildId),
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
});
