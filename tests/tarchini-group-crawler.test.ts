import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(resolve(ROOT, 'scripts/update-tarchini-group-jobs.mjs'), 'utf-8');

describe('Tarchini Group dedicated crawler', () => {
  it('skips global assembly in GitHub Actions slice runs', () => {
    expect(SCRIPT).toContain("process.env.GITHUB_ACTIONS === 'true'");
    expect(SCRIPT).toContain('Slice-only run: skipping global dataset assembly');
    expect(SCRIPT.indexOf('Slice-only run: skipping global dataset assembly')).toBeLessThan(
      SCRIPT.indexOf('await assembleJobsDataset();'),
    );
  });
});
