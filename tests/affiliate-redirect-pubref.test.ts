/**
 * /go/{partner}/ redirect — Partnerize `pubref` per placement (#7346).
 *
 * Every surface links the same `/go/{partner}/` page, so without a
 * per-position parameter Partnerize sees one undifferentiated click stream and
 * no slot can be optimised. The page turns `?pos=` (or, failing that, the
 * referring path) into `pubref` on the deeplink before redirecting.
 */
import { describe, it, expect } from 'vitest';
import { buildRedirectPage } from '../build-plugins/affiliateRedirectPlugin';
import { PARTNERS, isPartnerizeUrl } from '../services/affiliateService';

const wise = PARTNERS.find((p) => p.id === 'wise')!;

describe('affiliate redirect pubref', () => {
  it('ships the pubref rewrite on Partnerize partners', () => {
    expect(isPartnerizeUrl(wise.url)).toBe(true);
    const html = buildRedirectPage(wise);
    expect(html).toContain("searchParams.set('pubref'");
    expect(html).toContain("q.get(\"pos\")");
    expect(html).toContain('document.referrer');
    // the visible fallback link is patched too, so a JS-blocked-then-clicked
    // click carries the same placement as the automatic redirect
    expect(html).toContain('id="go-link"');
  });

  it('omits the rewrite on non-Partnerize partners', () => {
    const plain = PARTNERS.find((p) => !isPartnerizeUrl(p.url));
    if (!plain) return;
    expect(buildRedirectPage(plain)).not.toContain("searchParams.set('pubref'");
  });

  it('the build-time destination already carries a default pubref', () => {
    const html = buildRedirectPage(wise);
    expect(html).toContain('pubref=go-redirect');
  });
});
