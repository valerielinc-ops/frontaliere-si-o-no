import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RERENDER_WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'rerender-article-hubs.yml'),
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
});
