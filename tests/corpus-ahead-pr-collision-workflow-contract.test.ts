import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/pr-collision-detector.yml'), 'utf8');

describe('PR collision workflow contract', () => {
  it('keeps collision-risk labeling as the funnel protection', () => {
    expect(SOURCE).toContain('PR collision detector');
    expect(SOURCE).toContain('collision-risk');
  });
});
