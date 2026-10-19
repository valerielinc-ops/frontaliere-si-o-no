import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_KEY,
  MIN_SUMMARY_LENGTH,
  validateArticleExcerptFiles,
} from '../scripts/ci/check-article-excerpt-completeness.mjs';

const complete = 'Guy Parmelin was received in Hanoi on October 17, 2026, and Switzerland and Vietnam discussed trade, investment, sustainable urban development, employment and innovation before the planned agreement signing.';

describe('article excerpt completeness gate', () => {
  it('accepts the repaired article metadata and SEO descriptions', () => {
    const files = [
      'packages/articles/content/blog-meta-ch-de.ts',
      'packages/articles/content/blog-meta-ch-en.ts',
      'packages/articles/content/blog-meta-ch-fr.ts',
      'packages/articles/content/blog-meta-ch-it.ts',
      'packages/articles/content/seo/seo-blog-ch.ts',
    ];
    const result = validateArticleExcerptFiles(files);
    expect(result).toEqual({ checked: 7, failures: [] });
  });

  it('rejects short and known-truncated summaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-completeness-'));
    try {
      const file = join(directory, 'meta.ts');
      writeFileSync(file, `const meta = {\n  '${ARTICLE_KEY}': 'Parmelin am 17.',\n};\n`, 'utf8');
      const result = validateArticleExcerptFiles([file]);
      expect(result.checked).toBe(1);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures.join('\n')).toContain('known truncated fragment');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores matching text inside comments and multiline strings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-context-'));
    try {
      const file = join(directory, 'meta.ts');
      writeFileSync(file, `const fake = \`\n  '${ARTICLE_KEY}': '${complete}',\n\`;\nconst meta = {\n  // '${ARTICLE_KEY}': '${complete}',\n  '${ARTICLE_KEY}': 'Parmelin am 17.',\n};\n`, 'utf8');
      const result = validateArticleExcerptFiles([file]);
      expect(result.checked).toBe(1);
      expect(result.failures.join('\\n')).toContain('known truncated fragment');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the minimum threshold explicit for future callers', () => {
    expect(complete.length).toBeGreaterThan(MIN_SUMMARY_LENGTH);
  });
});
