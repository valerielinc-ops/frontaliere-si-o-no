import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStaticArticleTranslationEntries } from '../packages/articles/engine/shared/articleStaticSource.mjs';
import { repairArticleExcerptFiles } from '../scripts/lib/article-excerpt-repair.mjs';
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
        `const seo = {\n  'blog-demo': {\n    description: 'Un riassunto editoriale completo Oggetto',\n    ogDescription: 'Un riassunto editoriale completo Statements',\n    structuredData: { description: 'Un riassunto editoriale completo Objet' },\n  },\n};\n`,
        'utf8',
      );

      const result = validateArticleExcerptFiles([meta, seo], { all: true });
      expect(result.checked).toBe(4);
      expect(result.failures).toHaveLength(4);
      expect(result.failures.join('\n')).toContain('isolated section label');
      expect(result.failures.join('\n')).toContain('known truncated fragment');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs damaged metadata and SEO values at their last complete sentence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-sentence-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      const localRoot = join(directory, 'local');
      const seoDir = join(incomingRoot, 'seo');
      mkdirSync(seoDir, { recursive: true });
      mkdirSync(localRoot, { recursive: true });
      const sentence = 'Il Consiglio federale ha approvato oggi nuove misure per il Ticino.';
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      const seo = join(seoDir, 'seo-blog-5.ts');
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
  'blog.article.demo.excerpt': '${sentence} Oggetto',
};
export default translations;
`,
        'utf8',
      );
      writeFileSync(
        seo,
        `const seo = {
  'blog-demo': {
    description: '${sentence}',
    description: '${sentence} Oggetto',
    ogDescription: '${sentence} Oggetto',
    structuredData: { description: '${sentence} Oggetto' },
  },
};
`,
        'utf8',
      );

      const result = repairArticleExcerptFiles({
        files: [meta, seo],
        incomingRoot,
        localRoot,
      });

      expect(result.actions).toHaveLength(4);
      expect(result.actions.every((action) => action.strategy === 'last-complete-sentence')).toBe(true);
      expect(parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)[0].value).toBe(sentence);
      expect(validateArticleExcerptFiles([meta, seo], { all: true }).failures).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the matching local value when the incoming field has no complete sentence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-local-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      const localRoot = join(directory, 'local');
      mkdirSync(incomingRoot, { recursive: true });
      mkdirSync(localRoot, { recursive: true });
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      const localMeta = join(localRoot, 'blog-meta-it.ts');
      const localValue = 'Il Consiglio federale ha approvato oggi nuove misure per il Ticino.';
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
  'blog.article.demo.excerpt': 'Parmelin am 17.',
};
export default translations;
`,
        'utf8',
      );
      writeFileSync(
        localMeta,
        `const translations: Record<string, string> = {
  'blog.article.demo.excerpt': '${localValue}',
};
export default translations;
`,
        'utf8',
      );

      const result = repairArticleExcerptFiles({
        files: [meta],
        incomingRoot,
        localRoot,
      });

      expect(result.actions).toEqual([
        expect.objectContaining({ slug: 'demo', strategy: 'local-value' }),
      ]);
      expect(parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)[0].value).toBe(localValue);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finds a same-key local SEO value even when the article moved to another shard', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-local-shard-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      const localRoot = join(directory, 'local');
      const incomingSeoDir = join(incomingRoot, 'seo');
      const localSeoDir = join(localRoot, 'seo');
      mkdirSync(incomingSeoDir, { recursive: true });
      mkdirSync(localSeoDir, { recursive: true });
      const incomingSeo = join(incomingSeoDir, 'seo-blog-5.ts');
      const localSeo = join(localSeoDir, 'seo-blog-ch.ts');
      const localValue = 'Il Consiglio federale ha approvato oggi nuove misure per il Ticino.';
      writeFileSync(
        incomingSeo,
        `const seo = {
  'blog-demo': { description: 'Parmelin am 17.' },
};
`,
        'utf8',
      );
      writeFileSync(
        localSeo,
        `const seo = {
  'blog-demo': { description: '${localValue}' },
};
`,
        'utf8',
      );

      const result = repairArticleExcerptFiles({
        files: [incomingSeo],
        incomingRoot,
        localRoot,
      });

      expect(result.actions).toEqual([
        expect.objectContaining({ slug: 'demo', strategy: 'local-value' }),
      ]);
      expect(validateArticleExcerptFiles([incomingSeo], { all: true }).failures).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses an existing same-article SEO fallback supported by the RSS consumer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-seo-fallback-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      const localRoot = join(directory, 'local');
      const seoDir = join(incomingRoot, 'seo');
      mkdirSync(seoDir, { recursive: true });
      mkdirSync(localRoot, { recursive: true });
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      const seo = join(seoDir, 'seo-blog-5.ts');
      const safeDescription = 'Il Consiglio federale ha approvato nuove misure per il Ticino.';
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
  'blog.article.keep-this.excerpt': 'Parmelin am 17.',
};
export default translations;
`,
        'utf8',
      );
      writeFileSync(
        seo,
        `const seo = {
  'blog-keep-this': {
    headline: 'Misure federali per il Ticino',
    description: '${safeDescription}',
    ogDescription: 'Parmelin am 17.',
  },
};
`,
        'utf8',
      );

      const result = repairArticleExcerptFiles({
        files: [meta, seo],
        incomingRoot,
        localRoot,
      });

      expect(result.actions).toHaveLength(2);
      expect(result.actions.every((action) => action.strategy === 'seo-description-fallback')).toBe(true);
      expect(parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)[0].value)
        .toBe(safeDescription);
      expect(validateArticleExcerptFiles([meta, seo], { all: true }).failures).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps an incomplete value when no sentence or same-key local fallback exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-no-fallback-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      mkdirSync(incomingRoot, { recursive: true });
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
  'blog.article.keep-this.excerpt': 'Parmelin am 17.',
};
export default translations;
`,
        'utf8',
      );

      const result = repairArticleExcerptFiles({
        files: [meta],
        incomingRoot,
        localRoot: join(directory, 'local'),
      });

      expect(result.actions).toEqual([
        expect.objectContaining({
          slug: 'keep-this',
          strategy: 'kept-incomplete-no-local-value',
        }),
      ]);
      expect(result.remainingFailures.length).toBeGreaterThan(0);
      expect(parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)[0].value)
        .toBe('Parmelin am 17.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('throws when damaged fields exceed the systemic-failure threshold', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-threshold-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      mkdirSync(incomingRoot, { recursive: true });
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      const entries = Array.from(
        { length: 26 },
        (_, index) => `  'blog.article.demo-${index}.excerpt': 'Truncated excerpt Dichiarazioni',`,
      ).join('\n');
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
${entries}
};
export default translations;
`,
        'utf8',
      );

      expect(() => repairArticleExcerptFiles({
        files: [meta],
        incomingRoot,
        localRoot: join(directory, 'local'),
      })).toThrow('26 damaged excerpt/SEO fields');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves every article excerpt key while repairing a neighboring entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'article-excerpt-repair-inventory-'));
    try {
      const incomingRoot = join(directory, 'incoming');
      mkdirSync(incomingRoot, { recursive: true });
      const meta = join(incomingRoot, 'blog-meta-it.ts');
      const sentence = 'Il Consiglio federale ha approvato oggi nuove misure per il Ticino.';
      writeFileSync(
        meta,
        `const translations: Record<string, string> = {
  'blog.article.demo.excerpt': '${sentence} Oggetto',
  'blog.article.keep-this.excerpt': 'Una descrizione completa e valida che rimane nel corpus.',
};
export default translations;
`,
        'utf8',
      );
      const keysBefore = parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)
        .map((entry) => entry.articleId);

      repairArticleExcerptFiles({
        files: [meta],
        incomingRoot,
        localRoot: join(directory, 'local'),
      });

      const keysAfter = parseStaticArticleTranslationEntries(readFileSync(meta, 'utf8'), meta)
        .map((entry) => entry.articleId);
      expect(keysAfter).toEqual(keysBefore);
      expect(keysAfter).toEqual(['demo', 'keep-this']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
