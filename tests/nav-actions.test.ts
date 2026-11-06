import { describe, it, expect } from 'vitest';
import { NAV_ACTION_ROUTES } from '@/components/community/BlogArticles';

/**
 * Ensures every NavAction key is matchable by the rendering regex
 * used in renderInlineFormatting(). The regex character class for
 * action names must include all characters that appear in NavAction keys.
 * 
 * This test was added after a bug where `pillar3` (containing a digit)
 * was not matched by `[a-z\-]+`, causing raw markdown to appear on the page.
 */
describe('NavAction keys compatible with rendering regex', () => {
  // This is the regex character class used in renderInlineFormatting() and autoLinkKeywords()
  const navActionPattern = /^[a-z0-9\-]+$/;

  it('all NavAction keys match the rendering regex character class', () => {
    const keys = Object.keys(NAV_ACTION_ROUTES);
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      expect(
        navActionPattern.test(key),
        `NavAction key "${key}" contains characters not matched by the blog rendering regex [a-z0-9\\-]+. ` +
        `Update the regex in renderInlineFormatting() and autoLinkKeywords() in BlogArticles.tsx.`
      ).toBe(true);
    }
  });

  it('nav link regex can parse [text](nav:action) for every NavAction', () => {
    const renderRegex = /(\[([^\]]+)\]\(nav:([a-z0-9\-]+)\))/;

    for (const key of Object.keys(NAV_ACTION_ROUTES)) {
      const testStr = `[Test Link](nav:${key})`;
      const match = renderRegex.exec(testStr);
      expect(
        match,
        `Rendering regex failed to parse nav link for action "${key}"`
      ).not.toBeNull();
      expect(match![3]).toBe(key);
    }
  });
});
