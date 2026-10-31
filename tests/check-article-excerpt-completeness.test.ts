import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_KEY,
  ISOLATED_SECTION_LABELS,
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

  it('rejects isolated section labels across mirrored metadata and SEO fields', () => {
    expect(ISOLATED_SECTION_LABELS).toEqual(['Oggetto', 'Gegenstand', 'Subject', 'Objet']);
    const directory = mkdtempSync(join(tmpdir(), 'article-section-label-tail-'));
    try {
      const meta = join(directory, 'blog-meta-it.ts');
      const seo = join(directory, 'seo-blog-5.ts');
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {\n  'blog.article.demo.excerpt': 'Un riassunto editoriale completo Oggetto',\n};\nexport default translations;\n`,
        'utf8',
      );
      writeFileSync(
        seo,
        `const seo = {\n  'blog-demo': {\n    description: 'Un riassunto editoriale completo Oggetto',\n    ogDescription: 'Un riassunto editoriale completo Subject',\n    structuredData: { description: 'Un riassunto editoriale completo Objet' },\n  },\n};\n`,
        'utf8',
      );

      const result = validateArticleExcerptFiles([meta, seo], { all: true });
      expect(result.checked).toBe(4);
      expect(result.failures).toHaveLength(4);
      expect(result.failures.join('\n')).toContain('isolated section label');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
