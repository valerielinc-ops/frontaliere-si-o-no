/**
 * article-body-wordcount.test.ts
 *
 * Verifies that Italian blog body files meet the minimum word count threshold.
 * Thin content (< 300 words) is penalised by search engines and is a signal
 * that the article generation pipeline needs tuning.
 *
 * This is a hard gate: any article below MIN_WORDS fails the suite and blocks deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BLOG_BODY_IT_DIR = path.resolve(__dirname, '..', 'services', 'locales', 'blog-body', 'it');
const MIN_WORDS = 300;

function countWords(text: string): number {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}

function getArticleFiles(): string[] {
  if (!fs.existsSync(BLOG_BODY_IT_DIR)) return [];
  return fs.readdirSync(BLOG_BODY_IT_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(BLOG_BODY_IT_DIR, f));
}

describe('article body word count', () => {
  const files = getArticleFiles();

  it(`each article IT body should have at least ${MIN_WORDS} words`, () => {
    const failures: string[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Extract string content between backticks or quotes (simplified)
      const bodyText = content.replace(/^[^'`]*['`]/, '').replace(/['`][^'`]*$/, '');
      const words = countWords(bodyText);
      if (words < MIN_WORDS) {
        failures.push(`${path.basename(filePath)}: ${words} words`);
      }
    }

    if (failures.length > 0) {
      console.error('Articles below minimum word count:');
      failures.forEach(f => console.error(`  - ${f}`));
    }

    expect(failures).toHaveLength(0);
  });
});
