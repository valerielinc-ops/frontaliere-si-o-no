import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RERENDER_WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'rerender-article-hubs.yml'),
  'utf8',
);
const PARITY_WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'hydrated-article-parity.yml'),
  'utf8',
);

describe('hydrated parity recovery wiring', () => {
  it('replays the locked hub writer after a non-manual parity failure', () => {
    expect(RERENDER_WORKFLOW).toMatch(
      /workflow_run:\n\s+workflows: \["Hydrated article parity"\]\n\s+types: \[completed\]/u,
    );
    expect(RERENDER_WORKFLOW).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(RERENDER_WORKFLOW).toContain("github.event.workflow_run.event != 'workflow_dispatch'");
    expect(RERENDER_WORKFLOW).toContain('article-hub-surfaces');
    expect(RERENDER_WORKFLOW).toContain('group: hub-rerender-${{ matrix.section }}');
  });

  it('heals an automatic parity failure before opening the issue', () => {
    expect(PARITY_WORKFLOW).toContain('actions: write');
    expect(PARITY_WORKFLOW).toContain('name: Recover hydrated article parity before reporting');
    expect(PARITY_WORKFLOW).toContain('actions/workflows/rerender-article-hubs.yml/dispatches');
    expect(PARITY_WORKFLOW).toContain('inputs[recovery_request_id]');
    expect(PARITY_WORKFLOW).toContain('name: Recheck hydrated article parity after recovery');
    expect(PARITY_WORKFLOW).toContain('steps.recovery_check.outcome');
    expect(PARITY_WORKFLOW).toContain("steps.final_verdict.outcome == 'failure'");
    expect(PARITY_WORKFLOW).toContain("github.event_name != 'workflow_dispatch'");
  });
});
