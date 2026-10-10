import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/ci/validate-article-append-integrity.mjs');
let fixture: string | null = null;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = null;
});

describe('validate-article-append-integrity --swiss-only', () => {
  it('ignores an unrelated BLOG_SLUGS collision while preserving the Swiss gate', () => {
    fixture = mkdtempSync(path.join(tmpdir(), 'swiss-integrity-fixture-'));
    mkdirSync(path.join(fixture, 'services'), { recursive: true });
    mkdirSync(path.join(fixture, 'packages', 'articles', 'content'), { recursive: true });
    mkdirSync(path.join(fixture, 'public'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'packages/articles/content/routerSwissData.ts'),
      "export const SWISS_SLUGS = { 'swiss-a': { it: 'swiss-a-it', en: 'swiss-a-en', de: 'swiss-a-de', fr: 'swiss-a-fr' } };\n",
    );
    writeFileSync(
      path.join(fixture, 'services/routerBlogData.ts'),
      [
        'export const BLOG_SLUGS = {',
        " 'blog-a': { it: 'same', en: 'blog-a-en', de: 'blog-a-de', fr: 'blog-a-fr' },",
        " 'blog-b': { it: 'same', en: 'blog-b-en', de: 'blog-b-de', fr: 'blog-b-fr' },",
        '};',
      ].join('\n'),
    );
    writeFileSync(
      path.join(fixture, 'public/sitemap-test.xml'),
      '<urlset><url><loc>https://example.test/swiss-a</loc></url></urlset>\n',
    );

    const output = execFileSync('node', [SCRIPT, '--swiss-only'], {
      cwd: fixture,
      encoding: 'utf8',
    });

    expect(output).toMatch(/SWISS slug-uniqueness/);
    expect(output).not.toMatch(/BLOG/);
  });
});
