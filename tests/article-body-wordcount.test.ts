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

// Both blog-body (frontaliere section) and blog-body-ch (svizzera section)
// share the same {id}.ts-per-locale layout — checking only the former left
// the entire svizzera-section corpus (479 articles) ungated for thin content.
const BLOG_BODY_IT_DIRS = [
  path.resolve(__dirname, '..', 'services', 'locales', 'blog-body', 'it'),
  path.resolve(__dirname, '..', 'services', 'locales', 'blog-body-ch', 'it'),
];
const MIN_WORDS = 300;

function countWords(text: string): number {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}

function getArticleFiles(): string[] {
  return BLOG_BODY_IT_DIRS.flatMap((dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => path.join(dir, f));
  });
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
