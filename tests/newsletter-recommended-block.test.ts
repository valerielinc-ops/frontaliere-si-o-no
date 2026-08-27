/**
 * recommendedBlock — config-driven affiliate/sponsor revenue slot (#4450).
 *
 * Guards:
 *  - renders only when a partner/sponsor is active (never an empty box);
 *  - affiliate link routes through /go/{id}/ with a trailing slash + utm +
 *    acquisitionSource tracking;
 *  - a paid sponsor wins over affiliate partners;
 *  - copy is locale-correct (no cross-locale leak);
 *  - NEVER AdSense / Google Ads in email.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  renderRecommendedBlock,
  pickNewsletterRecommendation,
  buildRecommendedHref,
  NEWSLETTER_SPONSORS,
  NEWSLETTER_AFFILIATE_ENTRIES,
} from '../services/newsletter/recommendedBlock.mjs';

afterEach(() => {
  // Some tests push a temporary sponsor — always restore the empty default.
  NEWSLETTER_SPONSORS.length = 0;
});

describe('recommendedBlock selection', () => {
  it('picks an enabled affiliate partner and never an empty box', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const interest of ['general', 'jobs', 'utility', 'articles']) {
        const rec = pickNewsletterRecommendation({ locale, interest });
        expect(rec).not.toBeNull();
        expect(rec!.title).toBeTruthy();
        expect(rec!.cta).toBeTruthy();
        expect(rec!.disclosure).toBeTruthy();
      }
    }
  });

  it('routes an affiliate recommendation through /go/{id}/ with tracking + trailing slash', () => {
    const rec = pickNewsletterRecommendation({ locale: 'it', interest: 'general' });
    expect(rec!.kind).toBe('affiliate');
    const href = buildRecommendedHref(rec!, { acquisitionSource: 'weather-hub', campaign: 'weekly' });
    expect(href).toMatch(/^https:\/\/frontaliereticino\.ch\/go\/[a-z0-9-]+\/\?/);
    // trailing slash sits before the query string
    expect(href).toContain(`/go/${rec!.goId}/?`);
    expect(href).toContain('utm_source=newsletter');
    expect(href).toContain('utm_medium=email');
    expect(href).toContain('utm_campaign=weekly');
    expect(href).toContain('as=weather-hub');
  });

  it('lets a paid sponsor win over affiliate partners', () => {
    NEWSLETTER_SPONSORS.push({
      id: 'acme',
      name: 'Acme',
      emoji: '🏷️',
      url: 'https://acme.example/offer/',
      active: true,
      weight: 1,
      copy: {
        it: { title: 'Offerta Acme', body: 'Corpo IT', cta: 'Vai →' },
        en: { title: 'Acme offer', body: 'Body EN', cta: 'Go →' },
        de: { title: 'Acme Angebot', body: 'Body DE', cta: 'Los →' },
        fr: { title: 'Offre Acme', body: 'Body FR', cta: 'Aller →' },
      },
    });
    const rec = pickNewsletterRecommendation({ locale: 'it', interest: 'general' });
    expect(rec!.kind).toBe('sponsor');
    expect(rec!.id).toBe('acme');
    const href = buildRecommendedHref(rec!, { acquisitionSource: 'calc' });
    expect(href).toContain('https://acme.example/offer/');
    expect(href).toContain('utm_source=newsletter');
    expect(href).toContain('as=calc');
  });
});

describe('recommendedBlock render', () => {
  it('emits a block with disclosure and no AdSense', () => {
    const html = renderRecommendedBlock({ locale: 'it', interest: 'general', acquisitionSource: 'weather-hub' });
    expect(html).toContain('Consigliato per te');
    expect(html).toContain('/go/');
    expect(html).toContain('link affiliato');
    // Policy: never AdSense / Google Ads in email.
    expect(html).not.toMatch(/adsbygoogle|googlesyndication|adsense|data-ad-client/i);
  });

  it('renders locale-correct copy (no IT leak into EN)', () => {
    const en = renderRecommendedBlock({ locale: 'en', interest: 'general' });
    expect(en).toContain('Recommended for you');
    expect(en).not.toContain('Consigliato per te');
    expect(en).not.toMatch(/senza perderci/); // IT Wise copy must not appear
  });

  it('every affiliate entry has copy for all four locales', () => {
    for (const entry of NEWSLETTER_AFFILIATE_ENTRIES) {
      for (const loc of ['it', 'en', 'de', 'fr']) {
        expect(entry.copy[loc]?.title, `${entry.goId}/${loc}`).toBeTruthy();
        expect(entry.copy[loc]?.cta, `${entry.goId}/${loc}`).toBeTruthy();
      }
    }
  });

  // #6336 (follow-up of #6327): send-saved-jobs-digest.mjs and
  // send-job-alerts.mjs both splice this return value directly into an
  // outer `<table>` (`${recommendedBlockHtml}` between two `<tr>` siblings)
  // — never wrapped or conditionally rendered around a truthiness check on
  // shape, only on non-emptiness. A malformed or non-empty-but-partial `<tr>`
  // here would break the table for every recipient in both emails, so the
  // "no partner active" case is guarded explicitly rather than assumed safe
  // by analogy between the two call sites.
  it('returns exactly the empty string, never a malformed <tr>, when no partner or sponsor is active', () => {
    const savedEntries = NEWSLETTER_AFFILIATE_ENTRIES.splice(0, NEWSLETTER_AFFILIATE_ENTRIES.length);
    try {
      expect(pickNewsletterRecommendation({ locale: 'it', interest: 'general' })).toBeNull();
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(renderRecommendedBlock({ locale, interest: 'jobs' })).toBe('');
      }
    } finally {
      NEWSLETTER_AFFILIATE_ENTRIES.push(...savedEntries);
    }
  });

  it('when active, returns a single well-formed <tr>…</tr> row safe to splice into the outer table', () => {
    const html = renderRecommendedBlock({ locale: 'it', interest: 'general' });
    const trimmed = html.trim();
    expect(trimmed.startsWith('<tr>')).toBe(true);
    expect(trimmed.endsWith('</tr>')).toBe(true);
    // Exactly one top-level row: the block owns its own nested <table> for
    // the card, so nested <tr>s are expected, but there must be only one
    // outer <td class="section-pad"> opener — the cell the outer table sees.
    expect((trimmed.match(/<td class="section-pad"/g) || []).length).toBe(1);
  });
});
