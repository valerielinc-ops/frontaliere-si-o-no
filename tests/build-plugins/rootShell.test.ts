import { describe, it, expect } from 'vitest';
import { rootShell } from '../../build-plugins/htmlTemplate';

/**
 * `rootShell(hasSpaBundle)` gates the `.ft-hdr-reserve` first-paint header-height
 * spacer on the presence of the SPA bundle (PR #2808 / #2775).
 *
 * The spacer only reserves the sticky-nav header height correctly when React
 * actually mounts (createRoot replaces it with the real header). On a
 * bundle-less page — e.g. when `resolveEntryAssets` returns '' on a stale/missing
 * `dist/index.html` — React never mounts, so an unconditional spacer would sit as
 * a PERMANENT empty band above the indexed SEO content. The gate makes that
 * impossible by construction: no bundle → plain empty `#root` (the harmless
 * pre-fix degrade).
 */
describe('rootShell — header-reserve spacer is gated on the SPA bundle', () => {
  it('emits the .ft-hdr-reserve spacer when a bundle is present', () => {
    const html = rootShell(true);
    expect(html).toBe('<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div></div>');
    // spacer is the SOLE child of #root — no SEO content nested (bait-and-switch safe)
    expect(html).not.toMatch(/<main/);
  });

  it('emits a plain empty #root when there is NO bundle (no permanent gap)', () => {
    const html = rootShell(false);
    expect(html).toBe('<div id="root"></div>');
    // critically: NO spacer, so a never-mounting page degrades to 0px #root,
    // not a permanent header-height empty band.
    expect(html).not.toContain('ft-hdr-reserve');
  });
});
