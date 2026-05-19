/**
 * Funding Choices loader — regression test for the CORS-breaking crossOrigin
 * regression introduced 2026-05-04 (commit 0bbf6b99a0) and fixed 2026-05-19.
 *
 * Google FC `/i/pub-XXX` is served WITHOUT Access-Control-Allow-Origin headers.
 * Setting crossOrigin='anonymous' on the injected <script> turns the request
 * into a CORS fetch that the endpoint rejects with net::ERR_FAILED. The CMP
 * engine then never initializes, no TCF v2.2 string is emitted, EEA traffic
 * stays under the `no-tcf-string` policy (AD_PERSONALIZATION_RESTRICTED), and
 * page RPM stays capped at the non-personalized €1-3 range — the exact lever
 * documented in project_adsense_apr26 memory.
 *
 * This test pins the loader shape so the regression cannot return silently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(
  resolve(__dirname, '..', 'index.html'),
  'utf8',
);

// Extract the Funding Choices loader script block (between the loadFc IIFE
// and the closing </script>). Used by multiple assertions below.
const FC_LOADER_BLOCK = (() => {
  const start = indexHtml.indexOf("function loadFc()");
  expect(start, 'loadFc() block must exist in index.html').toBeGreaterThan(-1);
  const end = indexHtml.indexOf('</script>', start);
  expect(end, 'closing </script> after loadFc() must exist').toBeGreaterThan(start);
  return indexHtml.slice(start, end);
})();

describe('Funding Choices loader — index.html', () => {
  it('injects the fundingchoicesmessages.google.com loader for pub-8628054934855353', () => {
    expect(FC_LOADER_BLOCK).toMatch(
      /fundingchoicesmessages\.google\.com\/i\/pub-8628054934855353/,
    );
  });

  it('does NOT set crossOrigin on the FC loader <script> (would trigger CORS rejection)', () => {
    // Match `s.crossOrigin = '…'` or `s.crossOrigin = "…"` or
    // setAttribute('crossorigin', …) — both forms break the FC endpoint.
    expect(FC_LOADER_BLOCK).not.toMatch(/\.crossOrigin\s*=/);
    expect(FC_LOADER_BLOCK).not.toMatch(
      /setAttribute\(\s*['"]crossorigin['"]/i,
    );
  });

  it('marks the injected loader with data-fc-loader so we never double-inject', () => {
    expect(FC_LOADER_BLOCK).toMatch(/data-fc-loader/);
  });

  it('signals the googlefcPresent iframe so FC knows the loader ran', () => {
    expect(FC_LOADER_BLOCK).toMatch(/googlefcPresent/);
  });

  it('keeps the loader deferred (requestIdleCallback or DOMContentLoaded) — LCP safeguard', () => {
    // The 2026-05-04 LCP-defer commit (~11.3s → ~3-4s mobile LCP) must remain.
    expect(FC_LOADER_BLOCK).toMatch(/requestIdleCallback|DOMContentLoaded/);
  });
});
