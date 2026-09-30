import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_FILES = [
  'build-plugins/faqHubPlugin.ts',
  'build-plugins/shared/salaryLandingShell.ts',
  'build-plugins/seoHubsPlugin.ts',
  'build-plugins/weatherAlertPagesPlugin.ts',
  'build-plugins/weatherCityPagesPlugin.ts',
] as const;

describe('German home breadcrumb labels', () => {
  it('uses the descriptive Startseite label instead of the generic Start link', () => {
    for (const relativePath of SOURCE_FILES) {
      const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/locale === 'de' \? 'Start'/);
      expect(source, relativePath).not.toMatch(/\bde:\s*'Start'/);
    }

    expect(fs.readFileSync(path.resolve(SOURCE_FILES[0]), 'utf8')).toContain(
      "breadcrumbHome: 'Startseite'",
    );
    expect(fs.readFileSync(path.resolve(SOURCE_FILES[1]), 'utf8')).toContain(
      "breadcrumbHome: 'Startseite'",
    );
    expect(fs.readFileSync(path.resolve(SOURCE_FILES[2]), 'utf8')).toContain(
      "de: 'Startseite'",
    );
    for (const relativePath of SOURCE_FILES.slice(3)) {
      expect(fs.readFileSync(path.resolve(relativePath), 'utf8'), relativePath).toContain(
        "locale === 'de' ? 'Startseite'",
      );
    }
  });
});
