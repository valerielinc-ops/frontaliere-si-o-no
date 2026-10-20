import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/BlogArticles.tsx'),
  'utf8',
);

describe('BlogArticles — editorial transparency placement', () => {
  it('keeps the disclosure after the article body as the final article block', () => {
    const articleBody = SOURCE.indexOf('{/* Article body */}');
    const disclosure = SOURCE.indexOf('{/* Editorial transparency disclosure');
    const articleEnd = SOURCE.indexOf('\n </article>', disclosure);
    const disclosureEnd = SOURCE.indexOf('</aside>', disclosure) + '</aside>'.length;

    expect(articleBody).toBeGreaterThanOrEqual(0);
    expect(disclosure).toBeGreaterThan(articleBody);
    expect(disclosureEnd).toBeGreaterThan(disclosure);
    expect(articleEnd).toBeGreaterThan(disclosureEnd);
    expect(SOURCE.slice(disclosureEnd, articleEnd).trim()).toBe('');
    expect(SOURCE.match(/aria-label="Trasparenza editoriale"/g)).toHaveLength(1);
  });
});
