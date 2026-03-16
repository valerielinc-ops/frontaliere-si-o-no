import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('static pages blog detail rendering', () => {
  it('renders rich blog detail content instead of the generic editorial stub', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
    expect(source).toContain('const isBlogDetailPage = blogSlugs.includes(firstSeg)');
    expect(source).toContain('const blogArticleHtml = blogSectionData');
    expect(source).toContain('? `<div style="max-width:56rem;margin:0 auto;padding:1rem">${heroImg}<article>');
  });
});
