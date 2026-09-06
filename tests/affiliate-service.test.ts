/**
 * affiliateService — config-driven partner registry invariants (#4439/#4443).
 *
 * Guards:
 *  - disabled partners never surface (dormant config until owner signs)
 *  - /go/{partner}/ paths carry the canonical trailing slash
 *  - paid programs carry rel="sponsored", institutional links do not
 *  - exchange/banks top-2 cards stay visually unchanged (wise + fineco)
 *  - health context is populated (comparator + SSG premi pages surface)
 *  - Partnerize deeplinks carry a per-placement `pubref` (#7346)
 */
import { describe, it, expect } from 'vitest';
import {
  PARTNERS,
  getPartnersForContext,
  getAllPartners,
  buildGoPath,
  partnerRelAttr,
  buildAffiliateUrl,
  sanitizePubref,
  PUBREF_MAX_LEN,
} from '../services/affiliateService';
import { WISE_REFERRAL_URL, EXCHANGE_REFERRAL_PARTNERS } from '../services/exchangePartners';

describe('affiliateService config gates', () => {
  it('never surfaces disabled partners in any context', () => {
    const disabledIds = PARTNERS.filter(p => !p.enabled).map(p => p.id);
    const contexts = new Set(PARTNERS.flatMap(p => p.contexts));
    for (const ctx of contexts) {
      const surfaced = getPartnersForContext(ctx, 99).map(p => p.id);
      for (const id of disabledIds) {
        expect(surfaced).not.toContain(id);
      }
    }
    const all = getAllPartners().map(p => p.id);
    for (const id of disabledIds) {
      expect(all).not.toContain(id);
    }
  });

  it('builds /go/ paths with trailing slash for every partner', () => {
    for (const p of PARTNERS) {
      const path = buildGoPath(p);
      expect(path).toBe(`/go/${p.id}/`);
      expect(path.endsWith('/')).toBe(true);
    }
  });

  it('marks paid programs sponsored and institutional links plain', () => {
    expect(partnerRelAttr({ sponsored: true })).toBe('noopener noreferrer sponsored');
    expect(partnerRelAttr({ sponsored: false })).toBe('noopener noreferrer');
    // priminfo is the official FOPH comparator — must never claim sponsorship
    const priminfo = PARTNERS.find(p => p.id === 'priminfo');
    expect(priminfo?.sponsored).toBe(false);
  });

  it('keeps exchange and banks top-2 cards unchanged (anti-bias invariance)', () => {
    expect(getPartnersForContext('exchange').map(p => p.id)).toEqual(['wise', 'fineco']);
    expect(getPartnersForContext('banks').map(p => p.id)).toEqual(['wise', 'fineco']);
  });

  it('populates the health context (comparator + premi SSG surfaces)', () => {
    const health = getPartnersForContext('health', 99);
    expect(health.length).toBeGreaterThan(0);
    for (const p of health) {
      expect(p.enabled).toBe(true);
    }
  });

  it('registers every partner with a real URL (no bare referral stubs)', () => {
    for (const p of PARTNERS) {
      const url = new URL(p.url);
      expect(url.protocol).toBe('https:');
      // dead-referral guard (#4442): no /r/ or /referral/ paths without a code
      expect(p.url.endsWith('/r/')).toBe(false);
      expect(p.url.endsWith('/referral/')).toBe(false);
    }
  });

  it('Wise /go/ destination is the Partnerize referral, not the invite link', () => {
    const partnerize = 'https://wise.prf.hn/l/5mGYVAl/';
    expect(WISE_REFERRAL_URL).toBe(partnerize);

    const exchangeWise = EXCHANGE_REFERRAL_PARTNERS.find((p) => p.slug === 'wise');
    expect(exchangeWise?.referralUrl).toBe(partnerize);

    const wise = PARTNERS.find((p) => p.id === 'wise');
    expect(wise).toBeDefined();
    expect(wise!.url).toBe(partnerize);

    const dest = buildAffiliateUrl(wise!, 'go-redirect');
    expect(dest.startsWith(partnerize)).toBe(true);
    expect(new URL(dest).origin + new URL(dest).pathname).toBe(partnerize);
    expect(dest).not.toContain('wise.com/invite');
    // no UTM on the paid deeplink: extra params rewrite the destination
    expect(dest).not.toContain('utm_source');
  });

  it('tags Partnerize deeplinks with a per-placement pubref', () => {
    const wise = PARTNERS.find((p) => p.id === 'wise')!;

    const fromNewsletter = new URL(buildAffiliateUrl(wise, 'go-redirect', 'nl-partner-2'));
    expect(fromNewsletter.searchParams.get('pubref')).toBe('nl-partner-2');

    const fromArticle = new URL(buildAffiliateUrl(wise, 'go-redirect', 'article-body'));
    expect(fromArticle.searchParams.get('pubref')).toBe('article-body');

    // two placements must not collapse into the same tracked value
    expect(fromNewsletter.toString()).not.toBe(fromArticle.toString());

    // no placement → the source keeps the click attributable
    expect(new URL(buildAffiliateUrl(wise, 'go-redirect')).searchParams.get('pubref')).toBe(
      'go-redirect',
    );
  });

  it('normalises pubref values to a dashboard-safe slug', () => {
    expect(sanitizePubref('NL Partner #2')).toBe('nl-partner-2');
    expect(sanitizePubref('/cerca-lavoro-ticino/')).toBe('cerca-lavoro-ticino');
    expect(sanitizePubref('---')).toBe('');
    expect(sanitizePubref('x'.repeat(200)).length).toBeLessThanOrEqual(PUBREF_MAX_LEN);
    // a value that would be truncated mid-separator must not end with one
    expect(sanitizePubref('a'.repeat(PUBREF_MAX_LEN - 1) + '-bbb').endsWith('-')).toBe(false);
  });

  it('keeps UTM tracking on non-Partnerize partner URLs', () => {
    const plain = PARTNERS.find(
      (p) => !p.url.includes('prf.hn') && !p.url.includes('invite') && !p.url.includes('referral'),
    );
    if (!plain) return;
    const dest = new URL(buildAffiliateUrl(plain, 'go-redirect'));
    expect(dest.searchParams.get('utm_campaign')).toBe('go-redirect');
    expect(dest.searchParams.get('pubref')).toBeNull();
  });
});
