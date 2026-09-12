import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflowPath = path.resolve('.github/workflows/post-merge-followup.yml');

describe('post-merge follow-up mint gates', () => {
  it('keeps site and corpus gates unconditional after quota became telemetry', () => {
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(workflowText) as {
      jobs?: { followup?: { steps?: Array<Record<string, unknown>> } };
    };
    const steps = workflow.jobs?.followup?.steps ?? [];
    const mintGates = steps.filter((step) => (
      typeof step.name === 'string' && step.name.startsWith('Gate sul conio')
    ));

    expect(mintGates).toHaveLength(2);
    expect(mintGates.map((step) => step.if)).toEqual(['always()', 'always()']);
    expect(mintGates.every((step) => !String(step.if).includes('quota_blocked'))).toBe(true);

    const quotaTelemetry = steps.find((step) => step.id === 'quota');
    expect(quotaTelemetry).toMatchObject({
      name: 'Pre-flight — quota telemetry (Codex primary)',
      'continue-on-error': true,
    });
  });
});
