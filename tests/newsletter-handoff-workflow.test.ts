import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const newsletterWorkflow = readFileSync(
  new URL('../.github/workflows/send-newsletter.yml', import.meta.url),
  'utf8',
);
const parsed = YAML.parse(newsletterWorkflow) as {
  jobs: {
    newsletter: {
      if: string;
      steps: Array<Record<string, unknown>>;
    };
  };
};
const newsletterJob = parsed.jobs.newsletter;
const step = (name: string) => {
  const found = newsletterJob.steps.find((candidate) => candidate.name === name);
  expect(found, `missing workflow step: ${name}`).toBeDefined();
  return found as Record<string, unknown>;
};

describe('newsletter workflow handoff contract', () => {
  it('does not run for failed, manual, or non-scheduled source completions', () => {
    expect(newsletterJob.if).toContain("github.event.workflow_run.event == 'schedule'");
    expect(newsletterJob.if).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it('probes artifacts before downloading an optional handoff', () => {
    const locate = step('Locate primary job-alert handoff');
    expect(locate.uses).toBe('actions/github-script@v9');
    expect(locate.if).toBe("github.event_name == 'workflow_run'");
    const locateWith = locate.with as Record<string, unknown>;
    expect(String(locateWith.script)).toContain('listWorkflowRunArtifacts');
    expect(String(locateWith.script)).toContain("core.setOutput('found'");

    const download = step('Download primary job-alert handoff');
    expect(download.if).toContain("steps.locate_jobalert_handoff.outputs.found == 'true'");
    expect(download['continue-on-error']).toBeUndefined();
    expect(newsletterJob.steps.indexOf(locate)).toBeLessThan(newsletterJob.steps.indexOf(download));
  });
});
