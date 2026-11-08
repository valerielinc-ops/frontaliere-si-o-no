import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

describe('deploy workflow run title', () => {
  it('labels scheduled queue reconciliation as a no-build run', () => {
    const workflow = YAML.parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows/deploy.yml'), 'utf8')) as {
      name?: string;
      'run-name'?: string;
    };

    expect(workflow.name).toBe('Deploy to GitHub Pages');
    expect(workflow['run-name']).toBe(
      "${{ github.event_name == 'schedule' && 'Deploy queue reconciliation (no build)' || 'Deploy to GitHub Pages' }}",
    );
  });
});
