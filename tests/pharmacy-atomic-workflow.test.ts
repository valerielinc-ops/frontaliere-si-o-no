import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOWS = resolve(import.meta.dirname, '../.github/workflows');

describe('pharmacy atomic refresh workflow', () => {
  it('keeps the duty alias free of a release-less main writer', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacy-duties.yml'), 'utf8');
    expect(source).toContain('workflow_dispatch: {}');
    expect(source).toContain('uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(source).not.toContain('schedule:');
    expect(source).not.toMatch(/\bgit push\b/);
  });

  it('stages duties and finalizes them in the same border writer job', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    expect(source).toContain('workflow_call:');
    expect(source).toContain('continue-on-error: true');
    expect(source.match(/PHARMACY_DUTY_STAGE_DIR/g)).toHaveLength(2);
    expect(source).toContain('run: npm run pharmacies:import');
    expect(source).toContain('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json');
  });
});
