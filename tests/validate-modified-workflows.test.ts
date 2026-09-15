import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script, no type declarations
import {
  PROMPT_SCALAR_LIMIT,
  promptBlocks,
  validateLoopFleetWorkflowText,
  validateWorkflowText,
} from '../scripts/ci/validate-modified-workflows.mjs';

describe('validate-modified-workflows', () => {
  it('extracts each prompt block dedented without consuming the next YAML key', () => {
    const workflow = [
      'steps:',
      '  - name: Claude',
      '    prompt: |',
      '      first line',
      '      second line',
      '    timeout-minutes: 10',
    ].join('\n');

    expect(promptBlocks(workflow)).toEqual(['first line\nsecond line']);
  });

  it('honors an explicit YAML indentation indicator', () => {
    const workflow = [
      '  prompt: |2',
      '    first line',
      '      nested line',
      '  timeout-minutes: 10',
    ].join('\n');

    expect(promptBlocks(workflow)).toEqual(['first line\n  nested line']);
  });

  it('rejects a prompt scalar above the GitHub workflow limit', () => {
    const prompt = `prompt: |\n  ${'x'.repeat(PROMPT_SCALAR_LIMIT + 1)}`;

    expect(validateWorkflowText('.github/workflows/issue-fix.yml', prompt)).toEqual([
      {
        file: '.github/workflows/issue-fix.yml',
        index: 1,
        length: PROMPT_SCALAR_LIMIT + 1,
      },
    ]);
  });

  it('accepts a prompt exactly at the limit once dedented', () => {
    const prompt = `prompt: |\n  ${'x'.repeat(PROMPT_SCALAR_LIMIT)}`;

    expect(validateWorkflowText('.github/workflows/issue-fix.yml', prompt)).toEqual([]);
  });

  it('accepts a deeply indented prompt whose raw lines exceed the limit', () => {
    const body = Array.from({ length: 400 }, () => 'y'.repeat(45)).join('\n');
    const indented = body.split('\n').map((line) => `          ${line}`).join('\n');
    const workflow = `        prompt: |\n${indented}`;

    expect(body.length).toBeLessThan(PROMPT_SCALAR_LIMIT);
    expect(indented.length).toBeGreaterThan(PROMPT_SCALAR_LIMIT);
    expect(validateWorkflowText('.github/workflows/issue-fix.yml', workflow)).toEqual([]);
  });

  it('allows the bounded ledger branch and PR path', () => {
    const workflow = [
      'permissions:',
      '  contents: read',
      '  issues: write',
      'steps:',
      '  - run: git push -u origin "$branch"',
      '  - run: gh pr create --base main',
      '  - run: rm -rf "$RUNNER_TEMP/ledger"',
    ].join('\n');

    expect(validateLoopFleetWorkflowText('.github/workflows/loop-fleet-ledger.yml', workflow)).toEqual([]);
  });

  it('blocks direct main/force pushes, deploys, sends and commercial writes', () => {
    const workflow = [
      'permissions:',
      '  contents: write',
      'steps:',
      '  - run: git push --force origin main',
      '  - run: gh pr merge 123 --squash',
      '  - run: firebase deploy',
      '  - run: send-email --consent-required',
      '  - run: update price from source.json',
    ].join('\n');

    expect(validateLoopFleetWorkflowText('.github/workflows/loop-l7-experiment-allocator.yml', workflow).map(({ rule }) => rule))
      .toEqual(expect.arrayContaining([
        'writable-repository-permission',
        'direct-main-or-force-push',
        'manual-merge',
        'production-deploy',
        'communication-send',
        'commercial-mutation',
      ]));
  });

  it('scans only run scalars and stops before the next step key', () => {
    const workflow = [
      'steps:',
      '  - name: Describe',
      '    description: update revenue display text',
      '    run: |',
      '      echo "read-only check"',
      '    env:',
      '      NOTE: update price in a future human review',
    ].join('\n');

    expect(validateLoopFleetWorkflowText('.github/workflows/loop-l8-revenue-attribution.yml', workflow)).toEqual([]);
  });

  it('keeps the canonical fleet workflows inside the deny-list boundary', () => {
    const workflowDir = '.github/workflows';
    const files = fs.readdirSync(workflowDir)
      .filter((name) => /^(?:loop-l\d+-|loop-fleet-|technical-operations-supervisor\.yml$)/u.test(name))
      .filter((name) => /\.ya?ml$/u.test(name));
    const findings = files.flatMap((name) => validateLoopFleetWorkflowText(
      path.join(workflowDir, name),
      fs.readFileSync(path.join(workflowDir, name), 'utf8'),
    ));
    expect(files.length).toBeGreaterThan(10);
    expect(findings).toEqual([]);
  });
});
