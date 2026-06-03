import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const CSS_PATH = path.resolve(process.cwd(), 'public/assets/seo-static.css');

describe('seo-static.css', () => {
  it('parses through the extracted static class tail', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    expect(css).not.toMatch(/\[\^/);
    expect(css).not.toMatch(/'\s*\+\s*[A-Z_]+\s*\+\s*'/);
    expect(css).not.toMatch(/\\(?:\(|\))/);

    const root = postcss.parse(css, { from: CSS_PATH });
    const selectors = new Set<string>();
    root.walkRules((rule) => {
      selectors.add(rule.selector);
    });

    expect(selectors.has('.s-XENO3U')).toBe(true);
    expect(selectors.has('.s-rBJXSS')).toBe(true);
    expect(selectors.has('.s-zzuqwx')).toBe(true);
  });

  // Regression guard: relatedSearchClustersPlugin emits the crawler-only
  // `<div class="related-search-cluster">` body and relies on THIS file
  // carrying the off-screen (visually-hidden) recipe — the inline `style=`
  // was dropped to save ~24 MB across ~180k cluster pages. When the rule
  // went missing the block rendered fully visible in normal flow, duplicating
  // the SPA's hydrated job listing below it. Keep the rule (and its
  // off-screen positioning) so the SEO payload stays in the DOM for crawlers
  // without being visible to sighted users.
  it('keeps the .related-search-cluster crawler body off-screen (visually hidden)', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: CSS_PATH });

    let rule: postcss.Rule | undefined;
    root.walkRules('.related-search-cluster', (r) => {
      rule = r;
    });
    expect(rule, '.related-search-cluster rule must exist in seo-static.css').toBeDefined();

    const decls = new Map<string, string>();
    rule!.walkDecls((d) => decls.set(d.prop, d.value));

    // The off-screen recipe: out of flow + clipped to 1px so sighted users
    // see nothing while the content stays in the DOM for crawlers.
    expect(decls.get('position')).toBe('absolute');
    expect(decls.get('width')).toBe('1px');
    expect(decls.get('height')).toBe('1px');
    expect(decls.get('overflow')).toBe('hidden');
    expect(decls.get('clip')).toMatch(/rect\(\s*0/);
  });
});
