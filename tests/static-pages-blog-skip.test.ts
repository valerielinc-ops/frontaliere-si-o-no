import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('static pages blog detail rendering', () => {
  it('renders rich blog detail content instead of the generic editorial stub', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
    expect(source).toContain('const isBlogDetailPage = blogSlugs.includes(firstSeg)');
    expect(source).toContain('const blogArticleHtml = blogSectionData');
    // The wrapper div previously carried `style="max-width:56rem;margin:0 auto;padding:1rem"`
    // inline; after the 2026-05-20 inline-style → class extraction, the same rule lives
    // in seo-static.css under a content-hashed class (s-wWmcGm at time of writing).
    // The assertion accepts EITHER the legacy literal or the new class form so the test
    // survives further class-name churn driven by upstream style edits.
    expect(source).toMatch(/\?\s*`<div (style="max-width:56rem;margin:0 auto;padding:1rem"|class="s-[A-Za-z0-9_-]+")>\$\{heroImg\}<article>/);
  });
});
