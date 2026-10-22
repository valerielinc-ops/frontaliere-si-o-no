import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  hasLoopClockContract,
  patchLoopClockWorkflow,
} from '../scripts/ci/patch-corpus-loop-clock-workflow.mjs';

const ROOT = resolve(__dirname, '..');

describe('corpus loop-clock workflow transport', () => {
  it('keeps the local issue-triage workflow idempotent', () => {
    const source = readFileSync(resolve(ROOT, '.github/workflows/issue-triage.yml'), 'utf8');
    const result = patchLoopClockWorkflow(source);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(source);
    expect(hasLoopClockContract(source)).toBe(true);
  });

  it('adds only the marker contract to a legacy dispatch workflow', () => {
    const source = [
      'name: Corpus issue triage',
      'on:',
      '  issues:',
      '    types: [opened]',
      '  schedule:',
      "    - cron: '17 */4 * * *'",
      '  workflow_dispatch:',
      '    inputs:',
      '      cap:',
      "        default: '1'",
      '',
      'jobs:',
      '  sweep:',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n');

    const result = patchLoopClockWorkflow(source);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("run-name: ${{ github.event_name == 'workflow_dispatch'");
    expect(result.content).toContain("format('Corpus issue triage [loop-clock {0}]', inputs.loop_clock)");
    expect(result.content).toContain('      loop_clock:');
    expect(result.content).toContain('      cap:');
    expect(result.content).toContain('  schedule:');
    expect(hasLoopClockContract(result.content)).toBe(true);
    expect(patchLoopClockWorkflow(result.content)).toEqual({ content: result.content, changed: false });
  });

  it('fails closed for a workflow without a workflow_dispatch trigger', () => {
    expect(() => patchLoopClockWorkflow('name: Corpus issue triage\non:\n  schedule:\n    - cron: "*/15 * * * *"\n'))
      .toThrow(/workflow_dispatch trigger missing/u);
  });

  it('keeps the transport scoped to the external workflow', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/sync-loop-clock-to-corpus.yml'), 'utf8');
    expect(workflow).toContain('secrets.ARTICLES_REPO_PAT');
    expect(workflow).toContain('sync-loop-clock-to-corpus.sh');
    expect(workflow).toContain("'functions/src/loopClockTable.js'");
    expect(workflow).toContain("'scripts/ci/patch-corpus-loop-clock-workflow.mjs'");
  });
});
