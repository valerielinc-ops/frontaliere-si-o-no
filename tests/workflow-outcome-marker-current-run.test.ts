import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = [
  '.github/workflows/growth-report.yml',
  '.github/workflows/issue-decompose.yml',
];

function classifier(workflowPath: string): any {
  const document = YAML.parse(readFileSync(resolve(ROOT, workflowPath), 'utf8'));
  for (const job of Object.values<any>(document.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (String(step?.name).startsWith('Classify outcome')) return step;
    }
  }
  throw new Error(`classifier not found in ${workflowPath}`);
}

function workflowDocument(workflowPath: string): any {
  return YAML.parse(readFileSync(resolve(ROOT, workflowPath), 'utf8'));
}

function runMetadataResolver(workflowPath: string): any {
  const document = workflowDocument(workflowPath);
  for (const job of Object.values<any>(document.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.id === 'run_metadata') return step;
    }
  }
  throw new Error(`run metadata resolver not found in ${workflowPath}`);
}

describe('outcome marker: only the current run can prove delivery', () => {
  it.each(WORKFLOWS)('%s scopes the marker lookup to run_started_at', (workflowPath) => {
    const step = classifier(workflowPath);
    expect(step.env?.RUN_STARTED_AT).toBe('${{ steps.run_metadata.outputs.run_started_at }}');
    expect(String(step.run)).toContain('jq --arg started "$RUN_STARTED_AT"');
    expect(String(step.run)).toContain('select((.createdAt // "") > $started)');
    expect(String(step.run)).toMatch(/nessun (?:marker|verdetto)/);
    expect(String(step.run)).toMatch(/nessun (?:marker|verdetto)[\s\S]*exit 1/);
  });

  it.each(WORKFLOWS)('%s resolves run_started_at from the current run metadata', (workflowPath) => {
    const resolver = runMetadataResolver(workflowPath);
    expect(String(resolver.run)).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"');
    expect(String(resolver.run)).toContain(".run_started_at // empty");
    expect(String(resolver.run)).toContain('printf \'run_started_at=%s\\n\' "$RUN_STARTED_AT"');
  });

  it.each(WORKFLOWS)('%s grants the token read access to run metadata', (workflowPath) => {
    expect(workflowDocument(workflowPath).permissions?.actions).toBe('read');
  });
});
