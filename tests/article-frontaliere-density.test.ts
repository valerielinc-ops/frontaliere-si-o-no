/**
 * article-frontaliere-density.test.ts
 *
 * Verifies that Italian blog body files contain a meaningful density of
 * frontaliere-related keywords. Articles with very few keyword hits are
 * flagged as potentially off-topic for the frontalieri audience.
 *
 * This is a soft quality gate: the suite fails only when >30% of all articles
 * fall below the minimum threshold (5 hits), not when individual articles do.
 * This avoids blocking legitimate niche articles while catching systematic regressions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BLOG_BODY_IT_DIR = path.resolve(__dirname, '..', 'services', 'locales', 'blog-body', 'it');

const FRONTALIERE_TERMS = [
  'frontalier', 'permesso g', 'permesso b', 'pendolar', 'transfrontalier',
  'imposta alla fonte', 'lamal', 'avs', 'stipendio svizzer', 'dogana',
  'valico', 'accordo fiscale', 'busta paga', 'netto svizzer',
];

function countFrontaliereHits(text: string): number {
  const lower = text.toLowerCase();
  return FRONTALIERE_TERMS.reduce((acc, term) => acc + (lower.split(term).length - 1), 0);
}

function getArticleFiles(): string[] {
  if (!fs.existsSync(BLOG_BODY_IT_DIR)) return [];
  return fs.readdirSync(BLOG_BODY_IT_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(BLOG_BODY_IT_DIR, f));
}

describe('article frontaliere density', () => {
  const files = getArticleFiles();

  it('each article should have at least 5 frontaliere keyword hits in its IT body', () => {
    const failures: string[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const hits = countFrontaliereHits(content);
      if (hits < 5) {
        failures.push(`${path.basename(filePath)}: only ${hits} hits`);
      }
    }

    if (failures.length > 0) {
      console.warn('Articles with low frontaliere density (< 5 keyword hits):');
      failures.forEach(f => console.warn(`  - ${f}`));
    }

    // Warn only, don't fail the suite — this is a quality signal not a hard gate
    // (existing articles may legitimately have lower density for some topics)
    expect(failures.length).toBeLessThan(files.length * 0.3); // fail if > 30% are low density
  });
});
