import { describe, expect, it } from 'vitest';

import { normalizeFeedLineEndings } from '../packages/articles/engine/rssFeeds.mjs';

describe('FU-2026-10-21-006 RSS line-ending normalization', () => {
  it('normalizes CRLF and lone CR without changing Unicode line separators', () => {
    const value = 'first\r\nsecond\rthird\u2028fourth\u2029fifth';

    expect(normalizeFeedLineEndings(value)).toBe('first\nsecond\nthird\u2028fourth\u2029fifth');
  });
});
