import { describe, expect, it } from 'vitest';

import {
  buildAgieCharmillesLocalizedContent,
  cleanAgieCharmillesCity,
  parseAgieCharmillesDetailPage,
} from '@/scripts/lib/agie-charmilles-job-parser.mjs';
import { buildFallbackCanonicalContent } from '@/services/jobs/canonicalFallback';

const AGIE_DETAIL_HTML = `
<section>
  <p><a href="#" class="icon icon-back">Indietro</a></p>
  <table>
    <tr><td>None Angestellte (Schweiz)<br>None Angestellte (global)</td></tr>
    <tr><td><a href="http://www.gfms.com/">Homepage</a></td></tr>
  </table>
  <p class="job-list-desc" style="margin-top: 2em">
    Projektleiter\\*in Kundenprojekte<br>
    Projektleiter\\*in Kundenprojekte<br>
    Pensum: 100%<br>
    Arbeitsort: Biel<br>
    Anstellungsart: Unbefristet<br>
    Ihre Aufgaben<br>
    Leitung und Koordination interdisziplinärer Teams zur Entwicklung der nächsten Fräsmaschinen-Generation.<br>
    Gesamtverantwortung für den Projekterfolg hinsichtlich Time to Market, Kosten, Spezifikationen und Qualität.<br>
    Integration der Kundenperspektive in alle Projektphasen zur Sicherstellung einer marktnahen Produktentwicklung.<br>
    Verantwortung für zentrale Projektschritte inkl. Make-or-Buy-Entscheidungen und Lieferantenauswahl.<br>
    Sicherstellung einer effizienten Industrialisierung und eines erfolgreichen Produktionsstarts.<br>
    Verantwortlich für die Entwicklung von Prototypen sowie Tests bei Pilotkunden.<br>
    Ihr Profil<br>
    Abgeschlossenes Studium im Bereich Maschinenbau, Mechatronik oder einer vergleichbaren Fachrichtung.<br>
    Mehrjährige Erfahrung im Bereich Projektmanagement und der Entwicklung innovativer Maschinenbauprojekte.<br>
    Ausgeprägte Leadership-Kompetenzen mit Erfahrung in der Führung interdisziplinärer Teams.<br>
    Lösungsorientiertes Denken und Organisationstalent, unternehmerisch denkend und ergebnisorientiert.<br>
    Wir bieten<br>
    Ausgezeichnete Karrierechancen: UNITED MACHINING bietet viele Möglichkeiten zur Karriereentwicklung.<br>
    Ausgezeichnete Schulungsinstrumente: Wir bieten globale Lerntools sowie Schulungen und spezialisierte Kurse.<br>
    Fokus auf Nachhaltigkeit und Innovation: Wir arbeiten gemeinsam auf eine nachhaltige Zukunft hin.<br>
    Über United Machining<br>
    UNITED MACHINING ist einer der weltweit führenden Anbieter von Komplettlösungen für Hersteller von Präzisionskomponenten.<br>
    Ihre Kontaktperson<br>
    Imsand<br>
    Talent Acquisition Manager<br>
    \\+41 32 366 11 11<br>
    Web<br>
    E-Mail<br>
    Jetzt bewerben jid8622e88jm jit0519jm jiy26jm
  </p>
</section>`;

describe('agie-charmilles parser', () => {
  it('accepts one PLZ-city hyphen but does not strip separator-only input', () => {
    expect(cleanAgieCharmillesCity('CH-6616 Losone')).toBe('Losone');
    expect(cleanAgieCharmillesCity('CH-6616-Losone')).toBe('Losone');
    expect(cleanAgieCharmillesCity('CH-6616--')).toBe('6616--');
    expect(cleanAgieCharmillesCity('CH-6616--Losone')).toBe('6616--Losone');
  });

  it('extracts only the real job description from job-list-desc', () => {
    const { description } = parseAgieCharmillesDetailPage(AGIE_DETAIL_HTML);

    expect(description).toContain('## Ihre Aufgaben');
    expect(description).toContain('## Ihr Profil');
    expect(description).toContain('## Wir bieten');
    expect(description).toContain('- Leitung und Koordination interdisziplinärer Teams');
    expect(description).toContain('- Abgeschlossenes Studium');
    expect(description).toContain('- Ausgezeichnete Karrierechancen');
    expect(description).not.toContain('None Angestellte');
    expect(description).not.toContain('Homepage');
    expect(description).not.toContain('Indietro');
    expect(description).not.toContain('jid8622e88jm');
  });

  it('uses the inferred canton in the localized meta line', () => {
    const { description } = parseAgieCharmillesDetailPage(AGIE_DETAIL_HTML);
    const localized = buildAgieCharmillesLocalizedContent({
      title: 'Projektleiter*in Kundenprojekte 100%',
      city: 'Biel/Bienne',
      canton: 'TI',
      detailDescription: description,
    });

    expect(localized.descriptionByLocale.it).toContain('Biel/Bienne (BE)');
    expect(localized.descriptionByLocale.it).not.toContain('Biel/Bienne (TI)');
  });

  it('routes German AGIE headings into canonical sections', () => {
    const { description } = parseAgieCharmillesDetailPage(AGIE_DETAIL_HTML);
    const canonical = buildFallbackCanonicalContent(description, [], 'it');

    expect(canonical.responsibilities.join(' ')).toContain('Leitung und Koordination');
    expect(canonical.requirements.join(' ')).toContain('Abgeschlossenes Studium');
    expect(canonical.benefits.join(' ')).toContain('Ausgezeichnete Karrierechancen');
  });
});
