// Contract of scripts/ci/deploy-failure-classifier.mjs, shared with the publish
// retry. The shape of FAILURE_RULES and classifyDeployFailure must not drift.
import { describe, expect, it } from 'vitest';
import {
  classifyDeployFailure,
  extractFailurePaths,
  failedStepKeys,
  failureKey,
  FAILURE_RULES,
  normalizeFailureText,
} from '../scripts/ci/deploy-failure-classifier.mjs';

const failedJob = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'prep',
  status: 'completed',
  conclusion: 'failure',
  steps: [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Migrate slugs', conclusion: 'failure' },
  ],
  ...over,
});
const note = (message: string, extra: Record<string, unknown> = {}) => ({ annotation_level: 'failure', message, ...extra });

describe('FAILURE_RULES table', () => {
  it('is an ordered, frozen data table of infra|deterministic rules with unique ids', () => {
    expect(Object.isFrozen(FAILURE_RULES)).toBe(true);
    const ids = FAILURE_RULES.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of FAILURE_RULES as any[]) {
      expect(['infra', 'deterministic']).toContain(rule.classification);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
    // infra before the broad ERR_* catch-all: a transport error must not read as broken code
    const idx = (id: string) => ids.indexOf(id);
    expect(idx('network')).toBeLessThan(idx('node-error-code'));
    expect(idx('string-too-long')).toBeLessThan(idx('node-error-code'));
  });
});

describe('classifyDeployFailure', () => {
  it.each([
    ['The hosted runner lost communication with the server.', 'infra'],
    ['Failed to CreateArtifact: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON', 'infra'],
    ['Request failed with HTTP 502 Bad Gateway', 'infra'],
    ['read ECONNRESET', 'infra'],
    ['The job running on runner X has exceeded the maximum execution time of 360 minutes.', 'infra'],
    ['RangeError [ERR_STRING_TOO_LONG]: Cannot create a string longer than 0x1fffffe8 characters', 'deterministic'],
    ['[build-mem-guard] RSS 19.7 GB over the 19.5 GB ceiling', 'deterministic'],
    ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'deterministic'],
    ['AssertionError: expected 3 to be 4', 'deterministic'],
    ['error during build: RollupError: boom', 'deterministic'],
    ['TypeError [ERR_INVALID_ARG_TYPE]: bad', 'deterministic'],
    ['something nobody has ever seen', 'unknown'],
  ])('%s -> %s', (message, expected) => {
    const result = classifyDeployFailure({ jobs: [failedJob()], annotationsByJob: { 1: [note(message)] } });
    expect(result.classification).toBe(expected);
  });

  it('returns exactly the agreed shape with job, step and first error', () => {
    const result = classifyDeployFailure({
      jobs: [failedJob()],
      annotationsByJob: { 1: [note('Process completed with exit code 1.'), note('ERR_STRING_TOO_LONG in scripts/build-employer-profiles.mjs:70')] },
    });
    expect(Object.keys(result).sort()).toEqual(['classification', 'firstError', 'job', 'signature', 'step']);
    expect(result.job).toBe('prep');
    expect(result.step).toBe('Migrate slugs');
    // the generic exit-code line is skipped in favour of the specific one
    expect(result.firstError).toContain('ERR_STRING_TOO_LONG');
    expect(result.signature).toBe('prep::Migrate slugs::ERR_STRING_TOO_LONG in scripts/build-employer-profiles.mjs:#');
  });

  it('gives the same signature to the same defect on different SHAs, paths and numbers', () => {
    const a = classifyDeployFailure({
      jobs: [failedJob()],
      annotationsByJob: { 1: [note('ERR_STRING_TOO_LONG at /home/runner/work/r/r/scripts/x.mjs:70 sha 1a2b3c4d5e6f at 2026-11-12T04:56:01Z')] },
    });
    const b = classifyDeployFailure({
      jobs: [failedJob()],
      annotationsByJob: { 1: [note('ERR_STRING_TOO_LONG at /home/runner/work/r/r/scripts/x.mjs:72 sha 9f8e7d6c5b4a at 2026-11-12T05:04:44Z')] },
    });
    expect(a.signature).toBe(b.signature);
  });

  it('does not distinguish the matrix leg of the same failing step', () => {
    const leg = (loc: string, id: number) => classifyDeployFailure({
      jobs: [failedJob({ id, name: `build-locale (${loc})`, steps: [{ name: `Build (BUILD_LOCALE=${loc})`, conclusion: 'failure' }] })],
      annotationsByJob: { [id]: [note('[build-mem-guard] over the ceiling')] },
    });
    expect(leg('it', 5).signature).toBe(leg('de', 6).signature);
  });

  it('recognises a host-killed step that never concluded as infra', () => {
    const job = failedJob({
      steps: [
        { name: 'Build (BUILD_LOCALE=it)', status: 'in_progress', conclusion: null },
        { name: 'Report', status: 'pending', conclusion: null },
      ],
      completed_at: '2026-11-14T10:00:00Z',
    });
    const result = classifyDeployFailure({ jobs: [job], annotationsByJob: {} });
    expect(result.classification).toBe('infra');
    expect(result.step).toBe('Build (BUILD_LOCALE=*)');
  });

  it('keeps an artifact-style HTML token as infra only on an artifact/cache step', () => {
    const html = note("Unexpected token '<', \"<html>\" is not valid JSON");
    const onArtifact = classifyDeployFailure({
      jobs: [failedJob({ steps: [{ name: 'Upload artifact', conclusion: 'failure' }] })],
      annotationsByJob: { 1: [html] },
    });
    expect(onArtifact.classification).toBe('infra');
    const onTest = classifyDeployFailure({ jobs: [failedJob()], annotationsByJob: { 1: [html] } });
    expect(onTest.classification).toBe('unknown');
  });

  it('degrades to unknown instead of throwing on unreadable input', () => {
    expect(classifyDeployFailure({ jobs: undefined as any }).classification).toBe('unknown');
    expect(classifyDeployFailure({ jobs: [null as any] }).classification).toBe('unknown');
    expect(classifyDeployFailure(undefined as any).signature).toBe('no-failed-job');
  });
});

describe('several failed jobs', () => {
  const leg = (id: number, loc: string, step: string, conclusion = 'failure') => ({
    id, name: `build-locale (${loc})`, status: 'completed', conclusion,
    steps: [{ name: step, conclusion }],
  });

  it('describes the run by the leg that died of memory, not by siblings aborted at the barrier', () => {
    const result = classifyDeployFailure({
      jobs: [
        leg(1, 'de', 'Exchange hreflang manifests'),
        leg(2, 'it', 'Build (BUILD_LOCALE=it)'),
      ],
      annotationsByJob: {
        1: [note('Sibling build-locale (it) failed; aborting the barrier')],
        2: [note('Process completed with exit code 134.')],
      },
    });
    expect(result.classification).toBe('deterministic');
    expect(result.step).toBe('Build (BUILD_LOCALE=*)');
  });

  it('keeps a lost runner as infra over barrier noise', () => {
    const result = classifyDeployFailure({
      jobs: [leg(1, 'de', 'Exchange hreflang manifests'), leg(2, 'it', 'Build (BUILD_LOCALE=it)')],
      annotationsByJob: { 1: [note('barrier aborted')], 2: [note('The hosted runner lost communication with the server.')] },
    });
    expect(result.classification).toBe('infra');
  });

  it('a deterministic defect outranks infra noise in another job', () => {
    const result = classifyDeployFailure({
      jobs: [leg(1, 'de', 'Upload artifact'), leg(2, 'it', 'Build (BUILD_LOCALE=it)')],
      annotationsByJob: { 1: [note('Failed to CreateArtifact')], 2: [note('ERR_STRING_TOO_LONG')] },
    });
    expect(result.classification).toBe('deterministic');
  });

  it('failedStepKeys lists job::step of every failed job from the job list alone', () => {
    expect(failedStepKeys([
      leg(1, 'de', 'Exchange hreflang manifests'),
      leg(2, 'it', 'Build (BUILD_LOCALE=it)'),
      { id: 3, name: 'prep', status: 'completed', conclusion: 'success', steps: [] },
    ])).toEqual(['build-locale (*)::Exchange hreflang manifests', 'build-locale (*)::Build (BUILD_LOCALE=*)']);
  });
});

describe('helpers', () => {
  it('failureKey is the job::step prefix', () => {
    expect(failureKey('prep::Migrate slugs::boom #')).toBe('prep::Migrate slugs');
  });
  it('extractFailurePaths keeps repository source paths only', () => {
    expect(extractFailurePaths('ERR at scripts/build-employer-profiles.mjs:70 and /usr/lib/node/x.js, build-plugins/a.ts)'))
      .toEqual(['scripts/build-employer-profiles.mjs', 'build-plugins/a.ts']);
  });
  it('normalizeFailureText strips volatile fragments', () => {
    expect(normalizeFailureText('x 2026-11-12T04:56:01Z at /tmp/abc-123/f 4242 deadbeef1')).toBe('x <ts> at <tmp> # <sha>');
  });
});
