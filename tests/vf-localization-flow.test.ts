import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('VF localization flow', () => {
  it('runs fallback locale translation after the shared crawler', () => {
    const file = path.resolve(process.cwd(), 'scripts', 'update-vf-jobs.mjs');
    const source = fs.readFileSync(file, 'utf-8');

    expect(source).toContain('runDedicatedBaseCrawler');
    expect(source).toContain('translateMissingJobLocales');
    expect(source).toMatch(/await runBaseCrawler\(\);[\s\S]*await translateMissingJobLocales\(/);
  });
});
