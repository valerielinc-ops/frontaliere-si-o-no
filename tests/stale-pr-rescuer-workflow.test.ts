import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOW = '.github/workflows/stale-pr-rescuer.yml';

describe('stale PR rescuer workflow', () => {
  it('keeps each observed event out of the shared pending slot', () => {
    const config = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8'));

    expect(config.concurrency.group).toBe(
      'stale-pr-rescuer-${{ github.event.workflow_run.id || github.run_id }}',
    );
    expect(config.concurrency['cancel-in-progress']).toBe(false);
    expect(config.on.workflow_run.workflows).toEqual(['tests']);
    expect(config.on.workflow_run.types).toEqual(['completed']);
  });

  it('accepts a target-pinned manual dispatch and rejects a stale head before scanning', () => {
    const config = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8'));
    const inputs = config.on.workflow_dispatch.inputs;
    const scan = config.jobs.rescue.steps.find((step: { name?: string }) =>
      step.name === 'Scan open PRs and flag stalled ones');

    expect(inputs.pr).toMatchObject({ required: false, type: 'string' });
    expect(inputs.expected_head_sha).toMatchObject({ required: false, type: 'string' });
    expect(scan.env.TARGET_PR).toBe('${{ github.event.inputs.pr }}');
    expect(scan.env.EXPECTED_HEAD_SHA).toBe('${{ github.event.inputs.expected_head_sha }}');
    expect(scan.run).toContain('api "repos/$REPO/pulls/$TARGET_PR"');
    expect(scan.run).toContain('.headRefOid == $sha');
    expect(scan.run).toContain('echo "::notice::La PR target e la HEAD non coincidono');
    expect(scan.run).toContain('api --paginate "repos/$REPO/pulls?state=open&per_page=100"');
  });
});
