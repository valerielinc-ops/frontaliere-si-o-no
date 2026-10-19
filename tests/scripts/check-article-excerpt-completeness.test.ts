import { describe, expect, it } from 'vitest';
import {
  ARTICLE_SLUG,
  checkFiles,
  summaryFindings,
} from '../../scripts/ci/check-article-excerpt-completeness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTICLE_FILES = [
  path.join(ROOT, 'packages/articles/content/blog-meta-ch-de.ts'),
  path.join(ROOT, 'packages/articles/content/blog-meta-ch-en.ts'),
  path.join(ROOT, 'packages/articles/content/blog-meta-ch-fr.ts'),
  path.join(ROOT, 'packages/articles/content/blog-meta-ch-it.ts'),
  path.join(ROOT, 'packages/articles/content/seo/seo-blog-ch.ts'),
];

describe('check-article-excerpt-completeness', () => {
  it('accepts all four locale excerpts and all SEO copies for the article', () => {
    const report = checkFiles(ARTICLE_FILES);

    expect(ARTICLE_SLUG).toBe('svizzera-vietnam-relazioni-2026');
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.values).toHaveLength(7);
  });

  it('rejects the short and unterminated forms that caused the follow-up', () => {
    expect(summaryFindings('Parmelin am 17.')).toEqual(expect.arrayContaining([
      'only 15 characters (minimum 80)',
      'only 3 words (minimum 12)',
    ]));
    expect(summaryFindings('Parmelin received in Hanoi on October 17, 2026 Statements')).toContain(
      'does not end with sentence punctuation',
    );
  });
});

