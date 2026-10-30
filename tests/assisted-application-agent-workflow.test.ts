import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

type Step = {
  name?: string;
  run?: string;
  'working-directory'?: string;
};

const workflowSource = readFileSync(
  new URL('../.github/workflows/assisted-application-agent.yml', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource) as { jobs?: { agent?: { steps?: Step[] } } };
const steps = workflow.jobs?.agent?.steps ?? [];

describe('assisted application agent workflow dependencies', () => {
  it('installs the Functions dependency graph before starting the agent', () => {
    const functionsInstall = steps.findIndex((step) => (
      step['working-directory'] === 'functions' && /\bnpm ci\b/u.test(step.run || '')
    ));
    const agentRun = steps.findIndex((step) => step.name === 'Run agent');

    expect(functionsInstall).toBeGreaterThanOrEqual(0);
    expect(agentRun).toBeGreaterThan(functionsInstall);
  });
});
