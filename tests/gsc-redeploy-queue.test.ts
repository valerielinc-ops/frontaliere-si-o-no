import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GSC canonical regression handoff', () => {
  it('queues a bounded durable request and never dispatches deploy.yml directly', () => {
    const monitor = readFileSync(resolve('scripts/monitor-gsc-job-indexation.mjs'), 'utf8');
    expect(monitor).toContain('enqueueDeployRearmRequest');
    expect(monitor).not.toMatch(/gh\s+workflow\s+run\s+deploy\.yml/);
    expect(monitor).not.toMatch(/actions\/workflows\/deploy\.yml\/dispatches/);
    const workflow = readFileSync(resolve('.github/workflows/monitor-gsc-seo.yml'), 'utf8');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('statuses: write');
  });
});
