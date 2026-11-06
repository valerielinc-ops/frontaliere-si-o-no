import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SOURCE = execFileSync('git', ['show', 'HEAD:functions/src/trafficProviderMesh.js'], { encoding: 'utf8' });

describe('FU-2026-10-17-004 — webcam/provider baseline admission', () => {
  it('requires enough distinct feeds and valid pairs before promotion', () => {
    expect(SOURCE).toContain('export const WEBCAM_BASELINE_MIN_FEEDS = 3;');
    expect(SOURCE).toContain('export const WEBCAM_BASELINE_MIN_PAIRS = 3;');
    expect(SOURCE).toContain('export const WEBCAM_BASELINE_MIN_COVERAGE = 0.8;');
    expect(SOURCE).toContain('export function assessWebcamWaitBaseline(observations)');
    expect(SOURCE).toContain('feedKeys.size < WEBCAM_BASELINE_MIN_FEEDS');
    expect(SOURCE).toContain('pairs.length < WEBCAM_BASELINE_MIN_PAIRS');
  });

  it('keeps paid-request and accuracy checks fail-closed', () => {
    expect(SOURCE).toContain('row.incrementalPaidRequests === 0');
    expect(SOURCE).toContain('baseline collection must add zero paid provider requests');
    expect(SOURCE).toContain('candidatePairs.length !== pairs.length');
    expect(SOURCE).toContain('WEBCAM_BASELINE_MAX_MAE_MINUTES');
    expect(SOURCE).toContain('WEBCAM_BASELINE_MAX_ABSOLUTE_ERROR_MINUTES');
  });
});
