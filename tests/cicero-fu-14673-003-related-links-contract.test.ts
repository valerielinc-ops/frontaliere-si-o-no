import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SOURCE = execFileSync('git', ['show', 'HEAD:build-plugins/shared/relatedLinks.ts'], { encoding: 'utf8' });

describe('FU-2026-10-23-003 — contextual internal-link contract', () => {
  it('keeps explicit per-page and cluster caps', () => {
    expect(SOURCE).toContain('const MAX_LINKS_PER_PAGE = 12;');
    expect(SOURCE).toContain('const MIN_LINKS_PER_PAGE = 6;');
    expect(SOURCE).toContain('const MAX_SIBLING = 6;');
    expect(SOURCE).toContain('const MAX_HUBS = 3;');
    expect(SOURCE).toContain('const MAX_CROSS = 4;');
  });

  it('falls back to contextual legacy links when the structured result is thin', () => {
    expect(SOURCE).toContain('if (total < MIN_LINKS_PER_PAGE)');
    expect(SOURCE).toContain('const legacy = legacyFlatLinks(locale, pageType, context);');
    expect(SOURCE).toContain('generateRelatedLinksStructured');
  });
});
