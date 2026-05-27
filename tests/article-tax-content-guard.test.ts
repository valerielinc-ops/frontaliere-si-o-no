import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scannedRoots = [
  'services/locales/blog-body',
  'services/locales',
  'services/seo',
];

const filesToScan = scannedRoots.flatMap((root) =>
  collectFiles(join(repoRoot, root)).filter((file) =>
    /(?:blog-body\/.*\.ts|blog-meta-[a-z]+\.ts|seo-blog.*\.ts)$/.test(file)
  )
);

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return collectFiles(fullPath);
    return stats.isFile() ? [fullPath] : [];
  });
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('article tax calculation content guard', () => {
  it('keeps the CHF 65k new-frontier simulation aligned with the calculator', () => {
    const expectedFragmentsByLocale: Record<string, string[]> = {
      it: ['51\\\'610 CHF', '41\\\'251 CHF', '10\\\'359 CHF', '12\\\'699 EUR', '53\\\'291 EUR'],
      en: ['CHF 51,610', 'CHF 41,251', 'CHF 10,359', 'EUR 12,699', 'EUR 53,291'],
      de: ['51\\\'610 CHF', '41\\\'251 CHF', '10\\\'359 CHF', '12\\\'699 EUR', '53\\\'291 EUR'],
      fr: ['51\\\'610 CHF', '41\\\'251 CHF', '10\\\'359 CHF', '12\\\'699 EUR', '53\\\'291 EUR'],
    };

    for (const [locale, expectedFragments] of Object.entries(expectedFragmentsByLocale)) {
      const article = readRepoFile(
        `services/locales/blog-body/${locale}/simulazione-fiscale-frontaliere-2026.ts`
      );
      for (const fragment of expectedFragments) {
        expect(article, `${locale} simulation should contain ${fragment}`).toContain(fragment);
      }
    }
  });

  it('rejects known stale tax examples and inverted exchange-rate wording', () => {
    const forbiddenPatterns = [
      /61[.]900\s+EUR/i,
      /EUR\s+61,900/i,
      /61\s+900\s+EUR/i,
      /9[.]524\s+EUR/i,
      /EUR\s+9,524/i,
      /9\s+524\s+EUR/i,
      /9[.]976\s+EUR/i,
      /EUR\s+9,976/i,
      /9\s+976\s+EUR/i,
      /CHF\s*65[.'\s,]000[^\\n]{0,160}divis/i,
      /65[.'\s,]000\s+CHF[^\\n]{0,160}\/\s*1[,.]0[5-9]/i,
      /1CHF\s*=\s*1,05€/i,
      /1\s*CHF\s*=\s*1,05€[^\\n]{0,80}2,00\s*CHF/i,
    ];

    const violations = [];
    for (const file of filesToScan) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(text)) {
          violations.push(`${file.replace(`${repoRoot}/`, '')}: ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
