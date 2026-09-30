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

const GERMAN_LOCALE_PACK_FILES = [
  'build-plugins/bfsSalaryLandingsPlugin.ts',
  'build-plugins/borderWaitMapPlugin.ts',
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

  it('uses Startseite in the German locale packs surfaced by review', () => {
    for (const relativePath of GERMAN_LOCALE_PACK_FILES) {
      const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
      const germanPack = source.match(
        /\n\s+de:\s*\{([\s\S]*?)(?=\n\s+(?:fr|it|en):\s*\{|\n\s*\};)/,
      )?.[1];
      expect(germanPack, `${relativePath}: missing German locale pack`).toBeDefined();
      expect(germanPack, `${relativePath}: generic German home label remains`).toContain(
        "breadcrumbHome: 'Startseite'",
      );
      expect(germanPack, `${relativePath}: German locale still uses Home`).not.toContain(
        "breadcrumbHome: 'Home'",
      );
    }
  });
});
