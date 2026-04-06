import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPostFinanceBodyDescription } from '../scripts/update-postfinance-jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Verifies the PostFinance body-description extractor that pulls the full
 * job description from SuccessFactors `joblayouttoken` blocks instead of
 * the SEO-truncated `<meta name="description">` tag.
 *
 * The legacy `job.post.ch/PostFinance/job/...` pages render every job
 * field inside `<span class="rtltextaligneligible">` elements; the
 * description is the only span containing rich HTML (`<p>`, `<ul>`).
 */
describe('PostFinance body-description extractor', () => {
  it('extracts the full description from a real Compliance Officer page', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'postfinance-compliance-officer.html');
    const html = fs.readFileSync(fixturePath, 'utf-8');

    const description = extractPostFinanceBodyDescription(html);

    expect(description.length).toBeGreaterThanOrEqual(150);
    expect(description.toLowerCase()).toContain('compliance');
    expect(description.toLowerCase()).toContain('postfinance');
    // Make sure HTML tags were stripped.
    expect(description).not.toMatch(/<\/?p>/i);
    expect(description).not.toMatch(/<\/?li>/i);
  });

  it('returns an empty string for empty HTML', () => {
    expect(extractPostFinanceBodyDescription('<html></html>')).toBe('');
    expect(extractPostFinanceBodyDescription('')).toBe('');
  });

  it('returns an empty string when no rtltextaligneligible spans are present', () => {
    const html = `
      <html><head>
        <meta name="description" content="just a meta tag" />
        <title>Job Page</title>
      </head><body><p>nothing relevant</p></body></html>
    `;
    expect(extractPostFinanceBodyDescription(html)).toBe('');
  });

  it('decodes HTML entities and strips inline tags', () => {
    const longBody = 'A'.repeat(160);
    const html = `
      <div class="joblayouttoken">
        <span lang="it-IT" class="rtltextaligneligible">
          <p>Smith &amp; Co. &#39;welcomes&#39; you &mdash; ${longBody}</p>
          <ul><li>R&amp;D role</li></ul>
        </span>
      </div>
    `;
    const result = extractPostFinanceBodyDescription(html);
    expect(result).toContain('Smith & Co.');
    expect(result).toContain("'welcomes'");
    expect(result).toContain('R&D role');
    expect(result).not.toContain('&amp;');
    expect(result).not.toContain('&#39;');
    expect(result).not.toMatch(/<\/?p>/i);
  });

  it('prefers paragraph-style spans over short single-value spans', () => {
    const longBody = 'B'.repeat(200);
    const html = `
      <span class="rtltextaligneligible">Bellinzona</span>
      <span class="rtltextaligneligible">01.05.2026</span>
      <span class="rtltextaligneligible">75.000,00</span>
      <span class="rtltextaligneligible"><p>${longBody}</p></span>
      <span class="rtltextaligneligible">Sì</span>
    `;
    const result = extractPostFinanceBodyDescription(html);
    expect(result).toBe(longBody);
  });
});
