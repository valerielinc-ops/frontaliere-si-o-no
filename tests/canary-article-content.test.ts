import { describe, expect, it } from 'vitest';
import { buildCanaryIssueBody } from '../scripts/build-canary-issue-body.mjs';
import { buildFatalSummary, SITEMAP_URL, SITE } from '../scripts/canary-article-content.mjs';

describe('article-content canary fatal output', () => {
  it('keeps the machine-readable result contract when sitemap setup fails', () => {
    expect(buildFatalSummary(new TypeError('fetch failed'), '2026-10-29T02:42:49.000Z')).toEqual({
      site: SITE,
      sitemap: SITEMAP_URL,
      sampleSize: 0,
      pass: 0,
      fail: 0,
      failures: [],
      fatalError: 'fetch failed',
      timestamp: '2026-10-29T02:42:49.000Z',
    });
  });

  it('explains a fatal probe in the generated issue instead of inventing article failures', () => {
    const output = buildCanaryIssueBody(
      buildFatalSummary(new Error('sitemap fetch 503')),
      'https://example.test/run/1',
    );
    expect(output).toContain('**Sample:** unavailable — the canary failed before sampling articles');
    expect(output).toContain('**Result:** unavailable (sitemap fetch 503)');
    expect(output).toContain('### Canary failure');
    expect(output).not.toContain('### Failing URLs');
  });
});
