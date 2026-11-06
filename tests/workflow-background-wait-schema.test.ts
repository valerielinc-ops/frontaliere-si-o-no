/**
 * Schema statico per gli step GitHub Actions.
 *
 * `background:` e `wait-all:` non sono chiavi dello schema pubblico di GitHub
 * Actions. Il parallelismo intra-job deve quindi essere espresso da uno step
 * `run:` che avvia processi tracciabili e da uno step `run:` successivo che ne
 * raccoglie gli esiti. Questo test protegge anche gli artefatti generati e il
 * mirror portabile sotto `.github/corpus-workflows/`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIRS = [
  resolve(ROOT, '.github/workflows'),
  resolve(ROOT, '.github/corpus-workflows'),
];
const UNSUPPORTED_STEP_KEYS = new Set(['background', 'wait-all']);
const MIN_FILES = 200;
const MIN_STEPS = 200;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function workflowFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(path);
    }
  };
  visit(dir);
  return files.sort();
}

const parseErrors: string[] = [];
const unsupportedSteps: string[] = [];
const executorErrors: string[] = [];
let scannedFiles = 0;
let scannedSteps = 0;

for (const file of WORKFLOW_DIRS.flatMap(workflowFiles)) {
  scannedFiles += 1;
  const label = relative(ROOT, file);
  let document: unknown;
  try {
    document = YAML.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    parseErrors.push(`${label}: ${(error as Error).message}`);
    continue;
  }

  const jobs = isRecord(document) && isRecord(document.jobs) ? document.jobs : {};
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    if (!isRecord(rawJob) || !Array.isArray(rawJob.steps)) continue;
    rawJob.steps.forEach((rawStep, index) => {
      scannedSteps += 1;
      const location = `${label} → job \`${jobName}\` → step #${index + 1}`;
      if (!isRecord(rawStep)) {
        executorErrors.push(`${location}: step non rappresentato da una mappa`);
        return;
      }
      for (const key of Object.keys(rawStep)) {
        if (UNSUPPORTED_STEP_KEYS.has(key)) unsupportedSteps.push(`${location}: chiave ${key}`);
      }
      const hasRun = typeof rawStep.run === 'string';
      const hasUses = typeof rawStep.uses === 'string';
      if (hasRun === hasUses) {
        executorErrors.push(`${location}: esattamente uno tra run e uses richiesto`);
      }
    });
  }
}

describe('schema degli step GitHub Actions', () => {
  it('parsa tutti i workflow e percorre uno spazio non vuoto', () => {
    expect(parseErrors, `workflow non parsabili:\n${parseErrors.join('\n')}`).toEqual([]);
    expect(scannedFiles).toBeGreaterThanOrEqual(MIN_FILES);
    expect(scannedSteps).toBeGreaterThanOrEqual(MIN_STEPS);
  });

  it('non contiene chiavi step non supportate', () => {
    expect(
      unsupportedSteps,
      `chiavi step non supportate da GitHub Actions:\n${unsupportedSteps.join('\n')}`,
    ).toEqual([]);
  });

  it('ogni step ha esattamente un esecutore run o uses', () => {
    expect(
      executorErrors,
      `step senza esecutore o con esecutori multipli:\n${executorErrors.join('\n')}`,
    ).toEqual([]);
  });
});
