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
});
