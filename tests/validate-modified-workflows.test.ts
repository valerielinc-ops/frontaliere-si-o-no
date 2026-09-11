import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script, no type declarations
import {
  PROMPT_SCALAR_LIMIT,
  promptBlocks,
  validateWorkflowText,
} from '../scripts/ci/validate-modified-workflows.mjs';

describe('validate-modified-workflows', () => {
  it('extracts each prompt block without consuming the next YAML key', () => {
    const workflow = [
      'steps:',
      '  - name: Claude',
      '    prompt: |',
      '      first line',
      '      second line',
      '    timeout-minutes: 10',
    ].join('\n');

    expect(promptBlocks(workflow)).toEqual(['      first line\n      second line']);
  });

  it('rejects a prompt scalar above the GitHub workflow limit', () => {
    const prompt = `prompt: |\n  ${'x'.repeat(PROMPT_SCALAR_LIMIT + 1)}`;

    expect(validateWorkflowText('.github/workflows/issue-fix.yml', prompt)).toEqual([
      {
        file: '.github/workflows/issue-fix.yml',
        index: 1,
        length: PROMPT_SCALAR_LIMIT + 3,
      },
    ]);
  });

  it('accepts a prompt at the limit', () => {
    const prompt = `prompt: |\n  ${'x'.repeat(PROMPT_SCALAR_LIMIT - 2)}`;

    expect(validateWorkflowText('.github/workflows/issue-fix.yml', prompt)).toEqual([]);
  });
});
