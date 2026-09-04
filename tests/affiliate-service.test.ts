/**
 * affiliateService — config-driven partner registry invariants (#4439/#4443).
 *
 * Guards:
 *  - disabled partners never surface (dormant config until owner signs)
 *  - /go/{partner}/ paths carry the canonical trailing slash
 *  - paid programs carry rel="sponsored", institutional links do not
 *  - exchange/banks top-2 cards stay visually unchanged (wise + fineco)
 *  - health context is populated (comparator + SSG premi pages surface)
 */
import { describe, it, expect } from 'vitest';
import {
  PARTNERS,
  getPartnersForContext,
  getAllPartners,
  buildGoPath,
  partnerRelAttr,
  buildAffiliateUrl,
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
    expect(dest).toBe(partnerize);
    expect(dest).not.toContain('wise.com/invite');
  });
});
