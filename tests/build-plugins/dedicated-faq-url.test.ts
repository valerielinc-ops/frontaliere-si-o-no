/**
 * The generic static-page fallback also renders legacy FAQ aliases. Its
 * FAQPage JSON-LD must identify the page being rendered, including the
 * canonical trailing slash, rather than a duplicated hand-written URL.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.resolve(__dirname, '..', '..', 'build-plugins', 'staticPagesPlugin.ts'),
  'utf8',
);

describe('static FAQ fallback — structured-data URL follows the page canonical', () => {
  it('passes canonicalPath into the dedicated FAQ renderer', () => {
    expect(SOURCE).toMatch(
      /function buildDedicatedFaqHtml\([\s\S]*?\n canonicalPath: string,\n[\s\S]*?\n\}/,
    );
    expect(SOURCE).toContain(
      'buildDedicatedFaqHtml(faqItems, locale, canonicalPath, esc)',
    );
  });

  it('does not reintroduce a hand-written FAQ URL without the canonical slash', () => {
    expect(SOURCE).toContain("'url': `${BASE_URL}${canonicalPath}`,");
    expect(SOURCE).not.toContain("'url': `${BASE_URL}/${locale === 'it'");
  });
});
