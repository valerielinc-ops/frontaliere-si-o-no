import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

type Step = {
  name?: string;
  run?: string;
  if?: string;
  'working-directory'?: string;
  'timeout-minutes'?: number;
};

const workflowSource = readFileSync(
  new URL('../.github/workflows/assisted-application-agent.yml', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource) as { jobs?: { agent?: { steps?: Step[]; 'timeout-minutes'?: number } } };
const agentJob = workflow.jobs?.agent;
const steps = agentJob?.steps ?? [];

describe('assisted application agent workflow dependencies', () => {
  it('installs the Functions dependency graph before starting the agent', () => {
    const functionsInstall = steps.findIndex((step) => (
      step['working-directory'] === 'functions' && /\bnpm ci\b/u.test(step.run || '')
    ));
    const agentRun = steps.findIndex((step) => step.name === 'Run agent');

    expect(functionsInstall).toBeGreaterThanOrEqual(0);
    expect(agentRun).toBeGreaterThan(functionsInstall);
  });

  it('bounds Chromium setup and leaves the failure reporter reachable', () => {
    const chromiumInstall = steps.findIndex((step) => step.name === 'Install Chromium for the portal runner');
    const reconcileFailure = steps.findIndex((step) => step.name === 'Reconcile failed executor with the application queue');

    expect(chromiumInstall).toBeGreaterThanOrEqual(0);
    expect(steps[chromiumInstall]?.['timeout-minutes']).toBe(15);
    expect(steps[chromiumInstall]?.['timeout-minutes']).toBeLessThan(agentJob?.['timeout-minutes'] ?? 0);
    expect(reconcileFailure).toBeGreaterThan(chromiumInstall);
    expect(steps[reconcileFailure]?.if).toMatch(/failure\(\)/u);
  });
});
