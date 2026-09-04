import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemory,
  observeTranslations,
  serializeTranslationMemory,
} from '../scripts/lib/content-addressed-translation-memory.mjs';
import { planTranslationShadow } from '../scripts/lib/translation-shadow-planner.mjs';
import { runTranslationShadowPlanCli } from '../scripts/translation-shadow-plan.mjs';

const hit = {
  sourceLocale: 'de',
  targetLocale: 'it',
  fieldPath: 'title',
  sourceText: 'Softwareentwickler',
  provenance: { jobId: 'new-id', jobUrl: 'https://jobs.example/new-id' },
};

function fixtureMemory() {
  const conflictBase = {
    sourceLocale: 'fr',
    targetLocale: 'de',
    fieldPath: 'description.segments[2]',
    sourceText: 'Travail hybride',
  };
  return observeTranslations(createEmptyTranslationMemory(), [
    {
      ...hit,
      translatedText: 'Sviluppatore software',
      provenance: { jobId: 'old-id', jobUrl: 'https://jobs.example/old-id' },
    },
    { ...conflictBase, translatedText: 'Hybride Arbeit', provenance: { jobId: 'one' } },
    { ...conflictBase, translatedText: 'Hybridarbeit', provenance: { jobId: 'two' } },
  ]);
}

describe('translation shadow planner', () => {
  it('emits all decisions without mutating inputs or resolving conflicts', () => {
    const memory = fixtureMemory();
    const units = [
      hit,
      {
        sourceLocale: 'fr',
        targetLocale: 'de',
        fieldPath: 'description.segments[2]',
        sourceText: 'Travail hybride',
        provenance: { jobId: 'conflict' },
      },
      {
        sourceLocale: 'en',
        targetLocale: 'fr',
        fieldPath: 'title',
        sourceText: 'Data Engineer',
        provenance: { jobId: 'missing' },
      },
      {
        sourceLocale: 'de',
        targetLocale: 'en',
        fieldPath: 'title',
        sourceText: 'Projektleiter',
        existingTranslation: 'Project Manager',
        provenance: { jobId: 'complete' },
      },
      {
        sourceLocale: 'bad locale',
        targetLocale: 'it',
        fieldPath: 'title',
        sourceText: 'Ungültig',
        provenance: { jobId: 'invalid' },
      },
      {
        sourceLocale: 'de',
        targetLocale: 'it',
        fieldPath: 'title',
        sourceText: 'Ungültige Provenienz',
        provenance: { jobUrl: 'not-a-url' },
      },
    ];
    const unitsBefore = structuredClone(units);
    const memoryBefore = structuredClone(memory);

    const plan = planTranslationShadow({ units, memory });

    expect(plan.plans.map((item: { decision: string }) => item.decision)).toEqual([
      'exact_observed_hit',
      'conflicting_candidates',
      'missing_translation',
      'existing_translation_present_unvalidated',
      'invalid_identity',
      'invalid_unit',
    ]);
    expect(plan.summary).toEqual({
      total: 6,
      exact_observed_hit: 1,
      conflicting_candidates: 1,
      missing_translation: 1,
      invalid_identity: 1,
      invalid_unit: 1,
      existing_translation_present_unvalidated: 1,
    });
    expect(plan.plans[1]).not.toHaveProperty('selectedCandidate');
    expect(plan.plans[4].reasonCode).toBe('invalid_identity_fields');
    expect(plan.plans[5].reasonCode).toBe('invalid_provenance');
    expect(units).toEqual(unitsBefore);
    expect(memory).toEqual(memoryBefore);
  });

  it('produces byte-deterministic output for the same inputs', () => {
    const input = { units: [hit], memory: fixtureMemory() };

    expect(JSON.stringify(planTranslationShadow(input)))
      .toBe(JSON.stringify(planTranslationShadow(structuredClone(input))));
    expect(planTranslationShadow(input).digests).toEqual({
      input: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      memory: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('references shared candidates without repeating translation text or provenance per hit', () => {
    const shared = Array.from({ length: 1_000 }, (_, index) => ({
      ...hit,
      translatedText: 'Sviluppatore software',
      provenance: { jobId: `shared-${String(index).padStart(4, '0')}` },
    }));
    const memory = observeTranslations(createEmptyTranslationMemory(), shared);
    const plan = planTranslationShadow({
      memory,
      units: Array.from({ length: 1_000 }, (_, index) => ({
        ...hit,
        provenance: { jobId: `readded-${String(index).padStart(4, '0')}` },
      })),
    });

    expect(plan.plans).toHaveLength(1_000);
    expect(plan.plans[0].candidates[0]).toEqual({
      candidateId: expect.stringMatching(/^translation-output:v1:/),
      translationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      trust: 'observed',
      provenanceStoredCount: 32,
      provenanceTruncated: true,
    });
    expect(plan.plans.every((item: { candidates: Array<Record<string, unknown>> }) => (
      !('translatedText' in item.candidates[0]) && !('provenance' in item.candidates[0])
    ))).toBe(true);
    expect(JSON.stringify(plan).length).toBeLessThan(1_000_000);
  });

  it('runs as a report-only CLI with explicit paths and leaves both inputs unchanged', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-'));
    const inputPath = path.join(tempDir, 'units.json');
    const memoryPath = path.join(tempDir, 'memory.json');
    const shadowDir = path.resolve('.tmp/translation-shadow');
    fs.mkdirSync(shadowDir, { recursive: true });
    const outputPath = path.join(shadowDir, `plan-${process.pid}-${Date.now()}.json`);
    const inputBytes = `${JSON.stringify({ schemaVersion: 1, units: [hit] }, null, 2)}\n`;
    const memoryBytes = serializeTranslationMemory(fixtureMemory());
    fs.writeFileSync(inputPath, inputBytes);
    fs.writeFileSync(memoryPath, memoryBytes);

    const result = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(inputPath, 'utf8')).toBe(inputBytes);
    expect(fs.readFileSync(memoryPath, 'utf8')).toBe(memoryBytes);
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(report.summary.exact_observed_hit).toBe(1);
    expect(report.digests).toEqual({
      input: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      memory: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const directOutputPath = path.join(shadowDir, `direct-plan-${process.pid}-${Date.now()}.json`);
    const expectedReport = planTranslationShadow({ units: [hit], memory: fixtureMemory() });
    const returnedReport = runTranslationShadowPlanCli([
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', directOutputPath,
    ]);
    expect(returnedReport).toEqual(expectedReport);
    expect(JSON.parse(fs.readFileSync(directOutputPath, 'utf8'))).toEqual(expectedReport);
    expect(fs.readFileSync(inputPath, 'utf8')).toBe(inputBytes);
    expect(fs.readFileSync(memoryPath, 'utf8')).toBe(memoryBytes);

    fs.unlinkSync(outputPath);
    fs.unlinkSync(directOutputPath);
    fs.rmdirSync(shadowDir);
  });

  it('rejects implicit output and paths that could overwrite production or inputs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-'));
    const inputPath = path.join(tempDir, 'units.json');
    const memoryPath = path.join(tempDir, 'memory.json');
    fs.writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, units: [] }));
    fs.writeFileSync(memoryPath, serializeTranslationMemory(createEmptyTranslationMemory()));

    const noOutput = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs', '--input', inputPath, '--memory', memoryPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(noOutput.status).not.toBe(0);

    const overwriteInput = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', inputPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(overwriteInput.status).not.toBe(0);

    const productionPath = path.resolve('data/jobs/translation-shadow-plan.json');
    const productionWrite = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', productionPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(productionWrite.status).not.toBe(0);
    expect(fs.existsSync(productionPath)).toBe(false);

    const poisonedRunnerTemp = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', productionPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: process.cwd() },
    });
    expect(poisonedRunnerTemp.status).not.toBe(0);
    expect(fs.existsSync(productionPath)).toBe(false);

    const poisonedOsTemp = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', productionPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: process.cwd(),
        TMP: process.cwd(),
        TEMP: process.cwd(),
      },
    });
    expect(poisonedOsTemp.status).not.toBe(0);
    expect(fs.existsSync(productionPath)).toBe(false);

    const safeRunnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-runner-temp-'));
    const safeRunnerOutput = path.join(safeRunnerTemp, 'translation-plan.json');
    const safeRunnerWrite = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', safeRunnerOutput,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: safeRunnerTemp },
    });
    expect(safeRunnerWrite.status, safeRunnerWrite.stderr).toBe(0);
    expect(fs.existsSync(safeRunnerOutput)).toBe(true);
    fs.unlinkSync(safeRunnerOutput);

    const fakeSiblingRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sibling-repo-'));
    fs.mkdirSync(path.join(fakeSiblingRepo, '.git'));
    const fakeSiblingOutput = path.join(fakeSiblingRepo, 'translation-plan.json');
    const poisonedSiblingTemp = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', fakeSiblingOutput,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: fakeSiblingRepo },
    });
    expect(poisonedSiblingTemp.status).not.toBe(0);
    expect(fs.existsSync(fakeSiblingOutput)).toBe(false);

    const symlinkShadowRoot = path.resolve('.tmp/translation-shadow');
    expect(() => fs.lstatSync(symlinkShadowRoot)).toThrow();
    try {
      fs.symlinkSync(path.resolve('data/jobs'), symlinkShadowRoot, 'dir');
      const symlinkToProduction = spawnSync(process.execPath, [
        'scripts/translation-shadow-plan.mjs',
        '--input', inputPath,
        '--memory', memoryPath,
        '--output', path.join(symlinkShadowRoot, 'plan.json'),
      ], { cwd: process.cwd(), encoding: 'utf8' });
      expect(symlinkToProduction.status).not.toBe(0);
    } finally {
      fs.unlinkSync(symlinkShadowRoot);
    }

    for (const disallowedRoot of ['.translation-shadow', 'tmp/translation-shadow']) {
      const disallowedOutput = path.resolve(disallowedRoot, 'plan.json');
      const disallowedWrite = spawnSync(process.execPath, [
        'scripts/translation-shadow-plan.mjs',
        '--input', inputPath,
        '--memory', memoryPath,
        '--output', disallowedOutput,
      ], { cwd: process.cwd(), encoding: 'utf8' });
      expect(disallowedWrite.status).not.toBe(0);
      expect(fs.existsSync(disallowedOutput)).toBe(false);
    }

    const externalSymlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-symlink-target-'));
    try {
      fs.symlinkSync(externalSymlinkTarget, symlinkShadowRoot, 'dir');
      const symlinkToExternal = spawnSync(process.execPath, [
        'scripts/translation-shadow-plan.mjs',
        '--input', inputPath,
        '--memory', memoryPath,
        '--output', path.join(symlinkShadowRoot, 'plan.json'),
      ], { cwd: process.cwd(), encoding: 'utf8' });
      expect(symlinkToExternal.status).not.toBe(0);
      expect(fs.existsSync(path.join(externalSymlinkTarget, 'plan.json'))).toBe(false);
    } finally {
      fs.unlinkSync(symlinkShadowRoot);
    }

    const arbitraryExternalPath = path.resolve('..', '..', '..', '..', 'frontaliere-articles', 'shadow-plan.json');
    const externalWrite = spawnSync(process.execPath, [
      'scripts/translation-shadow-plan.mjs',
      '--input', inputPath,
      '--memory', memoryPath,
      '--output', arbitraryExternalPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(externalWrite.status).not.toBe(0);
    expect(fs.existsSync(arbitraryExternalPath)).toBe(false);
  });
});
