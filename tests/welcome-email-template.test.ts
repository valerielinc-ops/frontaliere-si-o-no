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
