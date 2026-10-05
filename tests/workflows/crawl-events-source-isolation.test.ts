import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * One events source must never freeze the whole events dataset.
 *
 * From 2026-10-04 the www.myswitzerland.com CDN refuses detail pages with
 * HTTP 406; the fail-closed detail-failure policy rejects that batch and the
 * MySwitzerland crawler exits 1. Before this guard the step had no
 * `continue-on-error`, so its failure skipped geneve, persist, assemble, gate
 * and publish for every source.
 *
 * Isolation alone would make the failure silent (continue-on-error turns the
 * job green), so each isolated crawl step needs a "Surface …" twin that reads
 * its `outcome` and fails the job AFTER publication — the order that lets
 * "Report failure to GitHub Issues" (if: failure()) fire while the other
 * sources still publish. Removing either half turns this test red.
 */

type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  'continue-on-error'?: boolean | string;
};

const workflowPath = path.resolve(__dirname, '../../.github/workflows/crawl-events.yml');
const workflow = YAML.parse(fs.readFileSync(workflowPath, 'utf8'));
const steps: Step[] = workflow.jobs['crawl-events'].steps;

const indexOfId = (id: string) => steps.findIndex((step) => step.id === id);
const surfacingStepsFor = (id: string) => steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => typeof step.run === 'string'
    && step.run.includes(`steps.${id}.outcome`)
    && /=\s*"failure"/.test(step.run)
    && /exit 1/.test(step.run)
    && !/failure\(\)/.test(String(step.if ?? '')));

describe('crawl-events.yml isolates failing sources without hiding them', () => {
  // Each isolated crawl step must be surfaced after publication.
  for (const id of ['crawl-myswitzerland', 'crawl-ge']) {
    describe(id, () => {
      it('is isolated with continue-on-error', () => {
        const index = indexOfId(id);
        expect(index, `step ${id} exists`).toBeGreaterThanOrEqual(0);
        expect(steps[index]['continue-on-error']).toBe(true);
      });

      it('has a surfacing step that reads its outcome and runs after the publish step', () => {
        const publish = indexOfId('commit');
        expect(publish).toBeGreaterThanOrEqual(0);
        const surfacing = surfacingStepsFor(id);
        expect(surfacing.length, `a step must read steps.${id}.outcome and exit 1`).toBeGreaterThan(0);
        for (const { step, index } of surfacing) {
          expect(String(step.if)).toContain('always()');
          expect(index).toBeGreaterThan(publish);
          expect(step['continue-on-error']).not.toBe(true);
        }
      });
    });
  }

  it('reports failures after the surfacing steps, so a surfaced failure opens the issue', () => {
    const report = steps.findIndex((step) => step.name === 'Report failure to GitHub Issues');
    expect(report).toBeGreaterThanOrEqual(0);
    expect(String(steps[report].if)).toContain('failure()');
    for (const id of ['crawl-myswitzerland', 'crawl-ge']) {
      for (const { index } of surfacingStepsFor(id)) expect(index).toBeLessThan(report);
    }
  });
});
