import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { shouldApplyApplicationRecovery } from '../scripts/ci/application-recovery-marker.mjs';

const recoveryWorkflow = parse(readFileSync(new URL('../.github/workflows/assisted-application-portal-recovery.yml', import.meta.url), 'utf8')) as any;
const deployWorkflow = parse(readFileSync(new URL('../.github/workflows/deploy-cloud-functions.yml', import.meta.url), 'utf8')) as any;

describe('assisted application recovery marker', () => {
  it('uses the selected commit for workflow_dispatch when head_commit is absent', () => {
    expect(shouldApplyApplicationRecovery({
      eventName: 'workflow_dispatch',
      selectedRevisionMessage: '[no-application-recovery] Bind portal submit to final form',
    })).toBe(false);
    expect(shouldApplyApplicationRecovery({
      eventName: 'workflow_dispatch',
      selectedRevisionMessage: 'ordinary deployment commit',
    })).toBe(true);
  });

  it('gates every apply step from the selected revision in both workflows', () => {
    const workflows = [
      recoveryWorkflow.jobs.recover.steps,
      deployWorkflow.jobs['deploy-functions'].steps,
    ];
    const applyGate = "${{ steps.application_recovery.outputs.apply == 'true' }}";
    for (const steps of workflows) {
      expect(steps.find((step: any) => step.id === 'application_recovery')?.run)
        .toContain('resolve-application-recovery-marker.mjs');
      const applySteps = steps.filter((step: any) => String(step.run || '').includes('--apply'));
      expect(applySteps).toHaveLength(2);
      expect(applySteps.every((step: any) => step.if === applyGate)).toBe(true);
    }
    expect(recoveryWorkflow.jobs.recover.steps.find((step: any) => step.uses === 'actions/checkout@v7').with.ref)
      .toBe('${{ github.sha }}');
    expect(deployWorkflow.jobs['deploy-functions'].steps.filter((step: any) => step.id === 'checkout_primary' || step.id === 'checkout_retry')
      .every((step: any) => step.with.ref === '${{ github.sha }}')).toBe(true);
  });
});
