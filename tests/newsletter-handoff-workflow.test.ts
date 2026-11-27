import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const newsletterWorkflow = readFileSync(
  new URL('../.github/workflows/send-newsletter.yml', import.meta.url),
  'utf8',
);
type Step = Record<string, unknown>;
type Job = {
  if?: string;
  needs?: string | string[];
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  outputs?: Record<string, string>;
  steps: Step[];
};
const parsed = YAML.parse(newsletterWorkflow) as {
  concurrency?: unknown;
  jobs: { gate: Job; newsletter: Job };
};
const gateJob = parsed.jobs.gate;
const newsletterJob = parsed.jobs.newsletter;
const step = (job: Job, name: string) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  expect(found, `missing workflow step: ${name}`).toBeDefined();
  return found as Step;
};
const uses = (job: Job) => job.steps.map((candidate) => String(candidate.uses ?? ''));

describe('newsletter workflow handoff contract', () => {
  it('admits only successful workflow_dispatch source runs for handoff validation', () => {
    expect(gateJob.if).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(gateJob.if).not.toContain("github.event.workflow_run.event == 'schedule'");
    expect(gateJob.if).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it('accepts only the versioned primary Cloud Scheduler handoff marker', () => {
    const verify = step(gateJob, 'Verify newsletter trigger');
    const run = String(verify.run);
    expect(run).toContain('.schema_version == 2');
    expect(run).toContain('.schedule == "job-alert-primary"');
    expect(run).toContain('.source_event == "workflow_dispatch"');
    expect(run).toContain('.trigger_source == "cloud-scheduler"');
    expect(run).toContain('.dry_run == "false"');
    expect(run).toContain('$source_event == "workflow_dispatch"');
    expect(run).toContain('SOURCE_DISPLAY_TITLE');
    expect(run).not.toContain('33 0 * * *');
  });

  it('probes artifacts before downloading an optional handoff', () => {
    const locate = step(gateJob, 'Locate primary job-alert handoff');
    expect(locate.uses).toBe('actions/github-script@v9');
    expect(locate.if).toBe("github.event_name == 'workflow_run'");
    const locateWith = locate.with as Record<string, unknown>;
    expect(String(locateWith.script)).toContain('listWorkflowRunArtifacts');
    expect(String(locateWith.script)).toContain("core.setOutput('found'");

    const download = step(gateJob, 'Download primary job-alert handoff');
    expect(download.if).toContain("steps.locate_jobalert_handoff.outputs.found == 'true'");
    expect(download['continue-on-error']).toBeUndefined();
    expect(gateJob.steps.indexOf(locate)).toBeLessThan(gateJob.steps.indexOf(download));
  });
});

// C3 (perf-plan email senders): inert workflow_run triggers must cost almost nothing
// and must never compete for the `newsletter` concurrency slot.
describe('inert workflow_run triggers (gate job)', () => {
  it('the gate has no repository checkout, no Node install and no assembly', () => {
    const gateUses = uses(gateJob);
    expect(gateUses.some((value) => value.startsWith('actions/checkout@'))).toBe(false);
    expect(gateUses.some((value) => value.startsWith('actions/setup-node@'))).toBe(false);
    expect(gateUses.some((value) => value.startsWith('./.github/actions/'))).toBe(false);
    const gateRuns = gateJob.steps.map((candidate) => String(candidate.run ?? '')).join('\n');
    expect(gateRuns).not.toMatch(/npm (ci|install)/);
    expect(gateRuns).not.toContain('assemble-jobs-dataset');
    expect(gateRuns).not.toContain('node scripts/');
  });

  it('the gate decides proceed for cron/manual runs and for a verified handoff only', () => {
    const verify = step(gateJob, 'Verify newsletter trigger');
    const run = String(verify.run);
    expect(run).toContain('echo "allow_run=true"');
    expect(run).toContain('echo "allow_run=false"');
    // Three inert exits (no handoff, failed validation) never output allow_run=true.
    const inertBlocks = run.split('exit 0').filter((block) => block.includes('stays inert'));
    expect(inertBlocks).toHaveLength(2);
    for (const block of inertBlocks) expect(block).not.toContain('allow_run=true');
    expect(gateJob.outputs?.proceed).toContain('steps.newsletter_trigger.outputs.allow_run');
    expect(gateJob.outputs?.trigger_key).toContain('steps.newsletter_trigger.outputs.trigger_key');
  });

  it('the real job depends on the gate and carries the concurrency group', () => {
    expect(newsletterJob.needs).toBe('gate');
    expect(newsletterJob.if).toBe("needs.gate.outputs.proceed == 'true'");
    expect(newsletterJob.concurrency).toEqual({ group: 'newsletter', 'cancel-in-progress': false });
  });

  it('no workflow-level concurrency: an inert run cannot replace a pending legitimate one', () => {
    expect(parsed.concurrency).toBeUndefined();
    expect(gateJob.concurrency).toBeUndefined();
  });

  it('only the real job pays checkout, the cached install and the assembly', () => {
    const newsletterUses = uses(newsletterJob);
    expect(newsletterUses.some((value) => value.startsWith('actions/checkout@'))).toBe(true);
    expect(newsletterUses).toContain('./.github/actions/npm-ci-cached');
    expect(newsletterUses).toContain('./.github/actions/assemble-jobs-cache-key');
    expect(newsletterJob.steps.some((candidate) => String(candidate.run ?? '').includes('assemble-jobs-dataset'))).toBe(true);
    const trigger = step(newsletterJob, 'Run newsletter job');
    expect(JSON.stringify(trigger.env)).toContain('needs.gate.outputs.trigger_key');
    // The per-step workflow_run guard is gone: the job only exists for a proceed run.
    expect(JSON.stringify(newsletterJob)).not.toContain('steps.newsletter_trigger.outputs.allow_workflow_run');
  });
});

// C4: the probe only ever removes the two provider setups, never adds work.
describe('frozen-content probe', () => {
  it('runs before the two setups and gates them on needs_llm != false (empty output = setups run)', () => {
    const probe = step(newsletterJob, 'Probe frozen newsletter content');
    expect(probe['continue-on-error']).toBe(true);
    expect(probe.id).toBe('content_probe');
    const probeIndex = newsletterJob.steps.indexOf(probe);
    const omniroute = newsletterJob.steps.find((candidate) => candidate.uses === './.github/actions/setup-omniroute') as Step;
    const haiku = newsletterJob.steps.find((candidate) => candidate.id === 'setup_claude_haiku_fallback') as Step;
    for (const setup of [omniroute, haiku]) {
      expect(newsletterJob.steps.indexOf(setup)).toBeGreaterThan(probeIndex);
      expect(String(setup.if)).toContain("steps.content_probe.outputs.needs_llm != 'false'");
    }
    expect(String(probe.run)).toContain('scripts/newsletter-content-probe.mjs');
  });

  it('exposes a dry-run mode that builds one email without a provider call', () => {
    expect(newsletterWorkflow).toContain('- dry-run');
    expect(newsletterWorkflow).toContain('node scripts/send-newsletter.mjs --dry-run');
  });
});
