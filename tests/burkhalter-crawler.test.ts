import { describe, expect, it } from 'vitest';
import {
  extractBurkhalterContentDescription,
  extractBurkhalterDetailFields,
  extractBurkhalterDetailDescription,
  extractBurkhalterJsonLdDescription,
  isBurkhalterStubText,
  mergeBurkhalterRecord,
} from '../scripts/lib/burkhalter-job-parser.mjs';

// Minimized from https://www.burkhalter.ch/en/jobs-and-careers/moechten-sie-bei-uns-arbeiten/detail/techniker-in-gebaeudeautomation-msrl-1664
// (2026-09-29). The page embeds a JobPosting whose description is the role; the visible
// content block adds the breadcrumb and the contact card around it.
const JSONLD = {
  '@context': 'https://schema.org/',
  '@type': 'JobPosting',
  title: 'Techniker/in Gebäudeautomation/MSRL',
  description: '<p>Wir sind ein Schweizer Unternehmen mit Kompetenzen in der Gebäudeautomation. Mit unserem Standort in Landquart und 8 Mitarbeitenden sind wir im ganzen Kanton Graubünden tätig.</p>\n<p>Bist du bereit für den nächsten Karriereschritt? Wir suchen eine/n Techniker/in Gebäudeautomation/MSRL (100%).</p><h3>Deine Aufgaben</h3>\n<ul><li data-list-item-id="e21b">Die qualitäts-, termin- und kostengerechte Programmierung und Inbetriebnahme von Steuerungs- und Visualisierungs-Software</li><li data-list-item-id="e820">Optimierung, Wartung und Support bestehender Systeme<br>&nbsp;</li></ul>\n<h3>Dein Profil</h3>\n<ul><li>Mehrjährige Erfahrung in den Bereichen SPS-Programmierung, Gebäudetechnik, Gebäude- und Raumautomation mit KNX und Dali</li></ul>\n<p>Bei Fragen kannst du dich an Max Muster, Geschäftsleiter, wenden (<a href="tel:+41000000000">+41 00 000 00 00</a>).&nbsp;</p>',
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Landquart', addressCountry: 'CH' } },
};

const CONTENT_BLOCK = `<div class="content"><ul class="breadcrumb"><li>Vacancies</li><li>Techniker/in Gebäudeautomation/MSRL</li></ul>
<h1>Techniker/in Gebäudeautomation/MSRL</h1><p>100%</p>
<p>Wir sind ein Schweizer Unternehmen mit Kompetenzen in der Gebäudeautomation.</p>
<h3>Deine Aufgaben</h3><ul><li>Optimierung, Wartung und Support bestehender Systeme</li></ul>
<div class="contact">AZ systems AG<br>Max Muster<br>Bahnhofplatz 3b<br>7302 Landquart</div></div><footer></footer>`;

const PAGE = `<html><head></head><body>${CONTENT_BLOCK.replace('</div><footer>', `<script type="application/ld+json">${JSON.stringify(JSONLD)}</script></div><footer>`)}</body></html>`;

describe('Burkhalter detail description (thin 9/245, missing-locales 6/245)', () => {
  it('reads the JSON-LD JobPosting description as markdown with lists', () => {
    const md = extractBurkhalterJsonLdDescription(PAGE);
    expect(md).toContain('## Deine Aufgaben\n\n- Die qualitäts-, termin- und kostengerechte Programmierung');
    expect(md).toContain('- Optimierung, Wartung und Support bestehender Systeme\n\n## Dein Profil');
    expect(md).toContain('Bei Fragen kannst du dich an Max Muster, Geschäftsleiter, wenden (+41 00 000 00 00).');
  });

  it('prefers JSON-LD: no breadcrumb, no repeated title, no contact card', () => {
    const md = extractBurkhalterDetailDescription(PAGE);
    expect(md).toMatch(/^Wir sind ein Schweizer Unternehmen/);
    expect(md).not.toMatch(/Vacancies|Bahnhofplatz 3b|7302 Landquart/);
  });

  it('keeps the source workplace address from JobPosting JSON-LD', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      ...JSONLD,
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Davos Platz',
          postalCode: '7270',
          streetAddress: 'Obere Strasse 19',
          addressCountry: 'CH',
        },
      },
    })}</script>`;
    expect(extractBurkhalterDetailFields(html, 'https://www.burkhalter.ch/job')).toMatchObject({
      addressLocality: 'Davos Platz',
      postalCode: '7270',
      streetAddress: 'Obere Strasse 19',
    });
  });

  it('falls back to the visible content block when the page has no JSON-LD posting', () => {
    const html = `<html><body>${CONTENT_BLOCK}</body></html>`;
    expect(extractBurkhalterJsonLdDescription(html)).toBe('');
    expect(extractBurkhalterDetailDescription(html)).toBe(extractBurkhalterContentDescription(html));
    expect(extractBurkhalterDetailDescription(html)).toContain('• Optimierung, Wartung und Support bestehender Systeme');
  });

  it('returns an empty string for a page it cannot read (the runner then retries)', () => {
    expect(extractBurkhalterDetailDescription('<html><body>429 Too Many Requests</body></html>')).toBe('');
  });

  it('never truncates a long posting: the tail (benefits, contact) stays published', () => {
    const body = '<p>Wir suchen eine engagierte Person für unser Team.</p>'.repeat(150);
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Elektroinstallateur/in EFZ',
      description: `${body}<p>Unser Angebot: fünf Wochen Ferien.</p>`,
    })}</script></head><body></body></html>`;
    const md = extractBurkhalterDetailDescription(html);
    expect(md.length).toBeGreaterThan(5000);
    expect(md).toContain('Unser Angebot: fünf Wochen Ferien.');
  });
});

// Stub texts stored in the slice of 2026-09-29 (…/techniker-in-gebaeudeautomation-msrl-1664 and a
// machine translation of another one).
const STUB = 'Techniker/in Gebäudeautomation/MSRL (100%) presso AZ systems AG, Landquart';
const STUB_EN = 'Description Installateurs-électriciens CFC (100%) at C2B Electrotechnique, branch of Grichting & Valterio Electro SA, Martigny';
const SOURCE = extractBurkhalterJsonLdDescription(PAGE);

describe('Burkhalter source-only merge (no `<title> presso …` stub)', () => {
  it('recognises the stub and its translations, not a posting', () => {
    expect(isBurkhalterStubText(STUB)).toBe(true);
    expect(isBurkhalterStubText(STUB_EN)).toBe(true);
    expect(isBurkhalterStubText(SOURCE)).toBe(false);
  });

  it('publishes the body read this run and drops stub slots', () => {
    const prev = { url: 'u', sourceLang: 'de', description: STUB, descriptionByLocale: { en: STUB, fr: STUB_EN, it: 'Traduzione:\nvera' } };
    const merged = mergeBurkhalterRecord(prev, { url: 'u', sourceLang: 'de', description: SOURCE, descriptionByLocale: { de: SOURCE } });
    expect(merged?.description).toBe(SOURCE);
    expect(merged?.descriptionByLocale).toEqual({ de: SOURCE, it: 'Traduzione:\nvera' });
  });

  it('keeps the stored source text when the page was not read this run', () => {
    const prev = {
      url: 'u',
      sourceLang: 'de',
      description: STUB,
      descriptionByLocale: { de: SOURCE, en: STUB },
      postalCode: '7270',
      streetAddress: 'Obere Strasse 19',
    };
    const merged = mergeBurkhalterRecord(prev, { url: 'u', sourceLang: 'de', description: '', descriptionByLocale: {} });
    expect(merged?.description).toBe(SOURCE);
    expect(merged?.descriptionByLocale).toEqual({ de: SOURCE });
    expect(merged).toMatchObject({ postalCode: '7270', streetAddress: 'Obere Strasse 19' });
  });

  it('does not publish a job with no body this run and only stubs stored', () => {
    const prev = { url: 'u', sourceLang: 'de', description: STUB, descriptionByLocale: { en: STUB } };
    expect(mergeBurkhalterRecord(prev, { url: 'u', sourceLang: 'de', description: '', descriptionByLocale: {} })).toBeNull();
    expect(mergeBurkhalterRecord(null, { url: 'u', sourceLang: 'de', description: '', descriptionByLocale: {} })).toBeNull();
  });
});
