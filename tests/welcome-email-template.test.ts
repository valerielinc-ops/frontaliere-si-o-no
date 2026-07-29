/**
 * welcomeEmailTemplate — post-signup welcome email (sent within seconds of
 * signup, before the newsletter or the onboarding drip ever fire).
 *
 * Guards:
 *  - all 20 segment × locale combinations render a valid, unsubscribe-bearing
 *    email with a subject ≤60 chars and never AdSense;
 *  - no unreplaced `{placeholder}` or literal null/undefined/NaN leaks into copy;
 *  - the 'job' segment reads as a natural, complete sentence in all three
 *    slot-survival shapes (company+sector+location / sector only / nothing);
 *  - firstName=null never produces the empty-slot "Ciao ," bug;
 *  - dynamic user/crawler-sourced values (firstName, company) are HTML-escaped;
 *  - 'publisher' (employer audience) never gets the consumer affiliate block
 *    or salary-calculator copy;
 *  - every frontaliereticino.ch href is trailing-slashed;
 *  - <html lang> matches the requested locale.
 */
import { describe, expect, it } from 'vitest';
import { buildWelcomeEmail } from '../functions/src/lib/welcomeEmailTemplate.js';

const SEGMENTS = ['job', 'salary', 'utility', 'publisher', 'general'] as const;
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

const UNSUB_URL = 'https://frontaliereticino.ch/?action=unsubscribe&email=a@b.com';
const PREFS_URL = 'https://frontaliereticino.ch/newsletter-preferences/?email=a@b.com';

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hrefs.push(m[1]);
  return hrefs;
}

describe('buildWelcomeEmail — all 20 segment x locale combinations', () => {
  for (const segment of SEGMENTS) {
    for (const locale of LOCALES) {
      it(`renders a valid email for ${segment}/${locale}`, () => {
        const { subject, preheader, html } = buildWelcomeEmail({
          segment,
          locale,
          unsubscribeUrl: UNSUB_URL,
        });

        expect(subject).toBeTruthy();
        expect(subject.length).toBeLessThanOrEqual(60);
        expect(preheader).toBeTruthy();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('action=unsubscribe');

        // never AdSense in a transactional email
        expect(html).not.toMatch(/adsbygoogle|googlesyndication|adsense/i);

        // no unreplaced template placeholder, no rendered null/undefined/NaN
        expect(html).not.toMatch(/\{\w+\}/);
        expect(html).not.toMatch(/>\s*null\s*[<,]/i);
        expect(html).not.toMatch(/>\s*undefined\s*[<,]/i);
        expect(html).not.toMatch(/>\s*NaN\s*[<,]/i);

        // <html lang> matches the requested locale
        expect(html).toMatch(new RegExp(`<html lang="${locale}">`));
      });
    }
  }
});

describe('job segment — three slot-survival shapes read as complete sentences', () => {
  it('company + sector + location: mentions all three', () => {
    const { html } = buildWelcomeEmail({
      segment: 'job',
      locale: 'it',
      company: 'UBS',
      sectorKey: 'finance',
      locationLabel: 'Lugano',
      unsubscribeUrl: UNSUB_URL,
    });
    expect(html).toContain('un’offerta di UBS nel settore finanza a Lugano');
    expect(html).not.toContain('le offerte per frontalieri');
  });

  it('sector only (no company, no location): natural sentence, no company/location fragments', () => {
    const { html } = buildWelcomeEmail({
      segment: 'job',
      locale: 'it',
      sectorKey: 'health',
      unsubscribeUrl: UNSUB_URL,
    });
    expect(html).toContain('un’offerta nel settore sanità');
    expect(html).not.toContain('un’offerta di'); // no "di {company}" fragment
    expect(html).not.toContain(' a Lugano');
    expect(html).not.toContain('le offerte per frontalieri');
  });

  it('nothing survived: falls back to the fully generic sentence', () => {
    const { html } = buildWelcomeEmail({
      segment: 'job',
      locale: 'it',
      unsubscribeUrl: UNSUB_URL,
    });
    expect(html).toContain('Ti sei iscritto mentre guardavi le offerte per frontalieri.');
    expect(html).not.toContain('nel settore');
  });
});

describe('greeting', () => {
  it('firstName=null produces the neutral welcome line, never "Ciao ,"', () => {
    const { html } = buildWelcomeEmail({ segment: 'general', locale: 'it', firstName: null, unsubscribeUrl: UNSUB_URL });
    expect(html).not.toContain('Ciao ,');
    expect(html).toContain('Benvenuto,');
  });

  it('firstName set produces "Ciao {name},"', () => {
    const { html } = buildWelcomeEmail({ segment: 'general', locale: 'it', firstName: 'Marco', unsubscribeUrl: UNSUB_URL });
    expect(html).toContain('Ciao Marco,');
  });
});

describe('HTML-escaping of dynamic, potentially untrusted values', () => {
  it('escapes a script-tag company name and a broken-out firstName', () => {
    const { html } = buildWelcomeEmail({
      segment: 'job',
      locale: 'it',
      company: '<script>alert(1)</script>',
      firstName: '"><b>x',
      unsubscribeUrl: UNSUB_URL,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"><b>x');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('publisher segment — different audience (employer, not job seeker)', () => {
  it('never shows the consumer affiliate/recommended block', () => {
    for (const locale of LOCALES) {
      const { html } = buildWelcomeEmail({ segment: 'publisher', locale, unsubscribeUrl: UNSUB_URL });
      expect(html).not.toContain('/go/wise/');
      expect(html).not.toMatch(/Consigliato per te|Recommended for you|Für dich empfohlen|Recommandé pour toi/);
    }
  });

  it('never tells the publisher to calculate their own net salary', () => {
    for (const locale of LOCALES) {
      const { html } = buildWelcomeEmail({ segment: 'publisher', locale, unsubscribeUrl: UNSUB_URL });
      expect(html).not.toMatch(/calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire/);
      expect(html).not.toMatch(/netto|net pay|Nettolohn|salaire net/i);
    }
  });

  it('non-publisher segments DO get the recommended block', () => {
    for (const segment of ['job', 'salary', 'utility', 'general'] as const) {
      const { html } = buildWelcomeEmail({ segment, locale: 'it', unsubscribeUrl: UNSUB_URL });
      expect(html).toContain('/go/wise/');
    }
  });
});

describe('every internal href is trailing-slashed', () => {
  it('all frontaliereticino.ch hrefs have a trailing-slash pathname', () => {
    for (const segment of SEGMENTS) {
      for (const locale of LOCALES) {
        const { html } = buildWelcomeEmail({
          segment,
          locale,
          company: 'Nestlé',
          sectorKey: 'industry',
          locationLabel: 'Chiasso',
          jobBackPath: '/annuncio/nestle-operaio-chiasso/',
          toolKey: 'lamal',
          unsubscribeUrl: UNSUB_URL,
          preferencesUrl: PREFS_URL,
          acquisitionSource: 'job-page',
        });
        const hrefs = extractHrefs(html).filter((h) => h.includes('frontaliereticino.ch'));
        expect(hrefs.length).toBeGreaterThan(0);
        for (const href of hrefs) {
          const pathname = new URL(href).pathname;
          expect(pathname.endsWith('/')).toBe(true);
        }
      }
    }
  });
});

describe('job segment — jobBackPath becomes the first quick link', () => {
  it('links back to the exact job page the user was viewing', () => {
    const { html } = buildWelcomeEmail({
      segment: 'job',
      locale: 'it',
      jobBackPath: '/annuncio/nestle-operaio-chiasso/',
      unsubscribeUrl: UNSUB_URL,
    });
    expect(html).toContain('https://frontaliereticino.ch/annuncio/nestle-operaio-chiasso/');
  });
});

describe('preferences link', () => {
  it('is present when preferencesUrl is given, absent when null', () => {
    const withPrefs = buildWelcomeEmail({ segment: 'general', locale: 'it', unsubscribeUrl: UNSUB_URL, preferencesUrl: PREFS_URL });
    expect(withPrefs.html).toContain(PREFS_URL);

    const withoutPrefs = buildWelcomeEmail({ segment: 'general', locale: 'it', unsubscribeUrl: UNSUB_URL, preferencesUrl: null });
    expect(withoutPrefs.html).not.toContain('newsletter-preferences');
  });
});

describe('CTA and quick links never point at the alert/newsletter preferences page', () => {
  // The preferences page only offers to pause/delete/unsubscribe — inviting
  // a just-signed-up reader there from a CTA or quick link would actively
  // hurt conversion. The footer's "manage preferences" link is the sole
  // legal exception and must keep working; this test scopes its assertion
  // to distinguish the two rather than banning the URL from the whole page.
  const PREFERENCES_SLUGS = ['preferenze-newsletter', 'newsletter-preferences', 'newsletter-einstellungen', 'preferences-newsletter'];

  it('no segment, in any locale, links to preferences from the CTA or quick links', () => {
    for (const segment of SEGMENTS) {
      for (const locale of LOCALES) {
        const { html } = buildWelcomeEmail({
          segment,
          locale,
          company: 'UBS',
          sectorKey: 'finance',
          locationLabel: 'Lugano',
          jobBackPath: '/annuncio/nestle-operaio-chiasso/',
          toolKey: 'lamal',
          jobAlertActive: true,
          unsubscribeUrl: UNSUB_URL,
          preferencesUrl: PREFS_URL,
        });

        const footerIndex = html.indexOf('class="footer-pad"');
        expect(footerIndex).toBeGreaterThan(-1);
        const aboveFooter = html.slice(0, footerIndex);
        const footer = html.slice(footerIndex);

        for (const slug of PREFERENCES_SLUGS) {
          expect(aboveFooter).not.toContain(slug);
        }

        // Sanity check the split is meaningful — the footer itself DOES
        // still legitimately carry the preferences link.
        expect(footer).toContain('newsletter-preferences');
      }
    }
  });

  it('holds for the job segment with alerts NOT yet active too', () => {
    for (const locale of LOCALES) {
      const { html } = buildWelcomeEmail({
        segment: 'job', locale, jobAlertActive: false,
        unsubscribeUrl: UNSUB_URL, preferencesUrl: PREFS_URL,
      });
      const footerIndex = html.indexOf('class="footer-pad"');
      const aboveFooter = html.slice(0, footerIndex);
      for (const slug of PREFERENCES_SLUGS) {
        expect(aboveFooter).not.toContain(slug);
      }
    }
  });
});

describe('CTA and quick-link labels never use alert-management verbs', () => {
  // "Refine/manage/pause/edit/delete your alerts" invites undoing the alert
  // that was just created — banned from the CTA and quick-link labels in
  // every locale. (The footer's "manage preferences" label is exempt, same
  // legal-link carve-out as the URL check above.)
  const BANNED_VERBS: Record<string, string[]> = {
    it: ['affina', 'gestisci', 'modifica', 'pausa', 'elimina'],
    en: ['manage', 'pause', 'edit', 'delete', 'adjust'],
    de: ['verwalten', 'pausieren', 'bearbeiten', 'löschen'],
    fr: ['gérer', 'mettre en pause', 'modifier', 'supprimer'],
  };

  function extractCtaLabels(html: string): string[] {
    return (html.match(/<a\b[^>]*>[^<]*<\/a>/g) || [])
      .filter((tag) => tag.includes('display:block;width:100%'))
      .map((tag) => (tag.match(/>([^<]*)<\/a>/)?.[1] || '').trim());
  }

  function extractQuickLinkLabels(html: string): string[] {
    return [...html.matchAll(/style="padding:14px 12px 14px 16px;font-size:14px;font-weight:700;color:[^"]*;">([^<]*)<\/td>/g)]
      .map((m) => m[1].trim());
  }

  it('no CTA or quick-link label, in any segment/locale, contains an alert-management verb', () => {
    for (const segment of SEGMENTS) {
      for (const locale of LOCALES) {
        const { html } = buildWelcomeEmail({
          segment,
          locale,
          company: 'UBS',
          sectorKey: 'finance',
          locationLabel: 'Lugano',
          jobBackPath: '/annuncio/nestle-operaio-chiasso/',
          toolKey: 'lamal',
          jobAlertActive: true,
          unsubscribeUrl: UNSUB_URL,
          preferencesUrl: PREFS_URL,
        });

        const labels = extractCtaLabels(html);
        const quickLinkLabels = extractQuickLinkLabels(html);
        expect(labels.length).toBeGreaterThan(0);
        expect(quickLinkLabels.length).toBeGreaterThan(0);
        const combined = [...labels, ...quickLinkLabels].join(' | ').toLowerCase();
        for (const verb of BANNED_VERBS[locale]) {
          expect(combined).not.toContain(verb.toLowerCase());
        }
      }
    }
  });

  it('holds for the job segment with alerts NOT yet active too', () => {
    for (const locale of LOCALES) {
      const { html } = buildWelcomeEmail({
        segment: 'job', locale, jobAlertActive: false,
        unsubscribeUrl: UNSUB_URL, preferencesUrl: PREFS_URL,
      });
      const combined = [...extractCtaLabels(html), ...extractQuickLinkLabels(html)].join(' | ').toLowerCase();
      for (const verb of BANNED_VERBS[locale]) {
        expect(combined).not.toContain(verb.toLowerCase());
      }
    }
  });
});

describe('recommended block — uses the real, registry-backed renderRecommendedBlock()', () => {
  // welcomeEmailTemplate.js now imports functions/src/lib/recommendedBlock.js
  // (which reads the live enable gate from
  // functions/src/lib/affiliatePartnersRegistry.js) instead of hardcoding a
  // card — same selection/rotation logic as the weekly newsletter and
  // onboarding drip, so a partner disabled in the registry disappears from
  // this email too, with no separate parity check to keep in sync.
  it('non-publisher segments link through the /go/{id}/ redirect with utm_campaign=welcome', () => {
    for (const segment of ['job', 'salary', 'utility', 'general'] as const) {
      const { html } = buildWelcomeEmail({ segment, locale: 'it', unsubscribeUrl: UNSUB_URL });
      const goHref = extractHrefs(html).find((h) => h.includes('/go/'));
      expect(goHref).toBeDefined();
      expect(goHref).toMatch(/\/go\/[a-z]+\//);
      expect(goHref).toContain('utm_campaign=welcome');
    }
  });

  it('publisher segment never links through /go/ (no consumer affiliate offer for employers)', () => {
    for (const locale of LOCALES) {
      const { html } = buildWelcomeEmail({ segment: 'publisher', locale, unsubscribeUrl: UNSUB_URL });
      expect(extractHrefs(html).some((h) => h.includes('/go/'))).toBe(false);
    }
  });
});
