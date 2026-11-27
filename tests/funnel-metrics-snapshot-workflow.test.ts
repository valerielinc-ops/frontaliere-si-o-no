import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = readFileSync(
  new URL('../.github/workflows/funnel-metrics-snapshot.yml', import.meta.url),
  'utf8',
);

describe('funnel-metrics-snapshot privacy contract', () => {
  it('keeps the old manual entry point read-only and retires scheduled collection', () => {
    const document = YAML.parse(workflow);

    expect(document.name).toContain('private migration');
    expect(document.on).toEqual({ workflow_dispatch: {} });
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(document.jobs.retired.steps).toHaveLength(1);
    expect(document.jobs.retired.steps[0].run).toContain('private operator report');
    expect(workflow).not.toMatch(/schedule:|data\/funnel-metrics-history|contents:\s*write|issues:\s*write/);
  });
});
