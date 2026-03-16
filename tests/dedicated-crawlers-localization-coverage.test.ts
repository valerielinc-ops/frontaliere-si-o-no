import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dedicated crawler localization coverage', () => {
  it('ensures every strict dedicated crawler uses shared localization or explicit fallback translation', () => {
    const scriptsDir = path.resolve(process.cwd(), 'scripts');
    const files = fs.readdirSync(scriptsDir)
      .filter((name) => /^update-.*\.mjs$/.test(name))
      .map((name) => path.join(scriptsDir, name));

    const gaps: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('validateDedicatedLocaleCoverage')) continue;

      const hasSharedLocalization = source.includes('runDedicatedBaseCrawler');
      const hasFallbackTranslation = source.includes('translateMissingJobLocales');

      if (!hasSharedLocalization && !hasFallbackTranslation) {
        gaps.push(path.basename(file));
      }
    }

    expect(gaps).toEqual([]);
  });
});
