import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/crawler-data-quality-audit.yml',
);

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('weekly crawler data-quality audit issue transport (#6787)', () => {
  it('precomputes multiline bodies and executes only the bounded packet', () => {
    const source = workflowSource();

    expect(source).toContain('Build bounded data-quality action packet');
    expect(source).toContain('scripts/ci/crawler-data-quality-candidates.mjs');
    expect(source).toContain('--open-issues /tmp/crawler-data-quality-open-issues.json');
    expect(source).toContain("OPEN_ISSUES_LIMIT: '100'");
    expect(source).toContain('--json number,title,body,comments --limit "$OPEN_ISSUES_LIMIT"');
    expect(source).toContain('--open-issues-limit "$OPEN_ISSUES_LIMIT"');
    expect(source).toContain('Execute bounded issue actions');
    expect(source).toContain('--execute true');
    expect(source).toContain('--packet /tmp/crawler-data-quality-candidates.json');
    expect(source).not.toContain('anthropics/claude-code-action');
    expect(source).not.toContain('claude_args:');
  });

  it('keeps the workflow read-only outside deterministic issue operations', () => {
    const source = workflowSource();

    expect(source).toMatch(/permissions:\n  contents: read\n  issues: write/);
    expect(source).not.toContain('id-token: write');
    expect(source).not.toContain('Setup Headroom compression proxy');
  });

  it('fetches enough history for every accepted lookback and has no turn budget', () => {
    const source = workflowSource();

    expect(source).toContain('WINDOW_DAYS + 5');
    expect(source).toContain('git fetch --shallow-since="$SINCE" origin main || git fetch --unshallow origin main');
    expect(source).not.toContain('--max-turns');
  });
});
