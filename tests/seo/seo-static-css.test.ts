import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const CSS_PATH = path.resolve(process.cwd(), 'public/assets/seo-static.css');
const SPA_CSS_PATH = path.resolve(process.cwd(), 'index.css');

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

// Cascade-source guard (follow-up #1257, deferred from #1249 review).
//
// #1249 restored the off-screen `.related-search-cluster` recipe in
// `seo-static.css`, but that file is only ONE layer of the cascade: every
// cluster page also loads the hashed SPA bundle compiled from `index.css`
// (`index-*.css`). If `index.css` later defines a more-specific or
// later-source `.related-search-cluster` rule that resets `position` away
// from `absolute`, the seo-static.css recipe is neutralised post-hydration
// and the ~9 KB crawler-only body reflows VISIBLE on ~180k cluster pages —
// re-opening the exact regression #1249 fixed, but invisible to the
// seo-static.css-only guard above.
//
// Symmetrically, the wrapper `<main class="cluster-seo-prose">` (the plugin
// keeps it OFF `seo-static-content` on purpose, relatedSearchClustersPlugin
// line ~1602, so it dodges the SPA lite-shell detector). Its only child is
// `position:absolute`, so the wrapper collapses to 0 height — UNLESS a
// `cluster-seo-prose` rule in `index.css` adds `padding`/`min-height`,
// which would leave a visible whitespace gap (added CLS → depressed Auto
// Ads RPM) even with the child off-screen.
//
// This guard fails the build if either competing rule appears in the SPA
// bundle source, locking the verification both review items deferred.
describe('index.css (SPA bundle source) cascade does not un-hide the cluster', () => {
  const collectRules = (selectorPart: string): postcss.Rule[] => {
    const css = fs.readFileSync(SPA_CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: SPA_CSS_PATH });
    const matches: postcss.Rule[] = [];
    root.walkRules((rule) => {
      if (rule.selector.includes(selectorPart)) matches.push(rule);
    });
    return matches;
  };

  it('does not override .related-search-cluster position out of the off-screen recipe', () => {
    for (const rule of collectRules('.related-search-cluster')) {
      rule.walkDecls('position', (d) => {
        expect(
          d.value,
          `index.css rule "${rule.selector}" resets .related-search-cluster ` +
            `position to "${d.value}" — this reflows the crawler-only body visible ` +
            `post-hydration, re-opening the #1249 regression. Keep position:absolute ` +
            `or drop the override.`,
        ).toBe('absolute');
      });
    }
  });

  it('does not give .cluster-seo-prose wrapper a visible footprint (padding/min-height)', () => {
    for (const rule of collectRules('cluster-seo-prose')) {
      rule.walkDecls(/^(padding|min-height)/, (d) => {
        const collapses = /^(0|0px|0em|0rem|none)$/i.test(d.value.trim());
        expect(
          collapses,
          `index.css rule "${rule.selector}" sets ${d.prop}:${d.value} on the ` +
            `cluster wrapper — its child is position:absolute, so this leaves a ` +
            `visible whitespace gap (added CLS) on ~180k cluster pages. Keep the ` +
            `wrapper collapsible (no padding / min-height).`,
        ).toBe(true);
      });
    }
  });
});
