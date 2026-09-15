import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/sync-pharmacy-duties-italy.yml', import.meta.url), 'utf8');

describe('Italian pharmacy duty workflow ownership', () => {
  it('is a separate writer with only the two Italian release artifacts', () => {
    expect(workflow).toContain('name: sync-pharmacy-duties-italy');
    expect(workflow).toContain('node scripts/import-pharmacy-duties-italy.mjs');
    expect(workflow).toContain('node scripts/check-pharmacy-duties-italy.mjs');
    expect(workflow).toContain('git add data/pharmacy-duties-italy.json data/pharmacy-duties-italy-status.json');
    expect(workflow).not.toContain('sync-pharmacies-border');
    expect(workflow).not.toContain('pharmacy-duties-ticino');
    expect(workflow).not.toContain('pharmacies-italy-border.json');
  });

  it('does not call the Farmacia Aperta service', () => {
    expect(workflow).not.toMatch(/farmacia-aperta|farmacia_aperta/i);
  });
});
