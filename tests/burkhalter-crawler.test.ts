import { describe, expect, it } from 'vitest';
import {
  extractBurkhalterContentDescription,
  extractBurkhalterDetailDescription,
  extractBurkhalterJsonLdDescription,
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

  it('falls back to the visible content block when the page has no JSON-LD posting', () => {
    const html = `<html><body>${CONTENT_BLOCK}</body></html>`;
    expect(extractBurkhalterJsonLdDescription(html)).toBe('');
    expect(extractBurkhalterDetailDescription(html)).toBe(extractBurkhalterContentDescription(html));
    expect(extractBurkhalterDetailDescription(html)).toContain('• Optimierung, Wartung und Support bestehender Systeme');
  });

  it('returns an empty string for a page it cannot read (the runner then retries)', () => {
    expect(extractBurkhalterDetailDescription('<html><body>429 Too Many Requests</body></html>')).toBe('');
  });
});
