// @vitest-environment node
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { startPipelinePhase } from '../scripts/lib/pipeline-phase-timing.mjs';

describe('pipeline phase timing', () => {
  it('emits monotonic structured events and a readable GitHub step summary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pipeline-phase-timing-'));
    try {
      const summaryPath = join(directory, 'summary.md');
      appendFileSync(summaryPath, 'Existing step summary.\n', 'utf8');
      const lines: string[] = [];
      let elapsed = 250;
      const finish = startPipelinePhase('dataset', 'reconcile | `slugs`\nphase', {
        now: () => elapsed,
        log: (line) => lines.push(line),
        summaryPath,
      });

      elapsed += 1_275;
      expect(finish('success')).toBe(1_275);
      expect(finish('failure')).toBe(0);

      const events = lines.map((line) => JSON.parse(line.replace(/^\[pipeline-timing\] /u, '')));
      expect(events).toEqual([
        { pipeline: 'dataset', phase: 'reconcile | `slugs`\nphase', event: 'start' },
        { pipeline: 'dataset', phase: 'reconcile | `slugs`\nphase', event: 'finish', duration_ms: 1_275, outcome: 'success' },
      ]);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toContain('Existing step summary.');
      expect(summary).toContain('### Pipeline timing — dataset / reconcile \\| \\`slugs\\` phase');
      expect(summary).toContain('Finished: `success`; duration: **1275 ms**.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps summary and logger failures observational', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pipeline-phase-timing-failed-summary-'));
    try {
      const lines: string[] = [];
      let failedSummaryEvents = 0;
      let elapsed = 100;
      const finish = startPipelinePhase('dataset', 'failed summary', {
        now: () => elapsed,
        log: (line) => {
          const event = JSON.parse(line.replace(/^\[pipeline-timing\] /u, ''));
          if (event.event === 'summary-write-failed') {
            failedSummaryEvents += 1;
            throw new Error('logger unavailable');
          }
          lines.push(line);
        },
        summaryPath: directory,
      });

      elapsed += 250;
      expect(finish('success')).toBe(250);
      expect(failedSummaryEvents).toBe(2);
      const events = lines.map((line) => JSON.parse(line.replace(/^\[pipeline-timing\] /u, '')));
      expect(events).toEqual([
        { pipeline: 'dataset', phase: 'failed summary', event: 'start' },
        { pipeline: 'dataset', phase: 'failed summary', event: 'finish', duration_ms: 250, outcome: 'success' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
