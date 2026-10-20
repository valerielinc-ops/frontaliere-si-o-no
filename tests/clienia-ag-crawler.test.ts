import { describe, expect, it } from 'vitest';
import { extractCleniaDetailContent } from '../scripts/lib/clienia-ag-job-parser.mjs';

// Detail page layout of clienia.ch on 2026-09-29 (JetEngine dynamic fields
// above a JetTabs widget), minimized from
// /de/jobs-karriere/jobs/fachperson-rechnungswesen-m-w-d-31362564066401/.
// The contact person is replaced with a placeholder name.
const field = (text: string) => `<div class="elementor-widget-container"><div class="jet-listing jet-listing-dynamic-field display-inline"><div class="jet-listing-dynamic-field__inline-wrap"><div class="jet-listing-dynamic-field__content" >${text}</div></div></div></div>`;
const DETAIL_HTML = `<!DOCTYPE html><html lang="de"><body>
<nav><a>Jobs/Karriere</a><a>Zuweisende</a></nav>
${field('Code 3136256.4066401')}
${field('Die Clienia-Gruppe gehört zu den grössten privaten Anbieterinnen psychiatrischer Dienstleistungen in der Schweiz.<br />Mit über 20 Standorten bietet sie ein vielfältiges Spektrum an psychiatrischen und psychotherapeutischen Behandlungsmethoden an.<br /><br />Für den Bereich Rechnungswesen suchen wir per sofort oder nach Vereinbarung eine')}
<h1 class="elementor-heading-title elementor-size-large">Fachperson Rechnungswesen (m/w/d) (50% - 100%)</h1>
${field('Arbeitsort ist Littenheid oder Oetwil am See')}
<div class="jet-tabs__control-wrapper"><div class="jet-tabs__label-text">Stellenbeschrieb</div><div class="jet-tabs__label-text">Arbeitsort</div></div>
<div class="jet-tabs__content-wrapper">
<div id="jet-tabs-content-9581" class="jet-tabs__content active-content" data-tab="1" role="tabpanel" aria-hidden="false" data-template-id="false"><strong>Deine Aufgaben</strong><br /><ul><li>Du führst das Hauptbuch inkl. der Kontoabstimmungen</li><li>Du verantwortest den Monatsabschluss und unterstützt bei den Jahresabschlüssen</li></ul><strong>Dein Profil</strong><br /><ul><li>Du verfügst über eine Weiterbildung im Finanz- und Rechnungswesen</li><li>Du arbeitest selbstständig, strukturiert und gerne im Team</li></ul><strong>Unser Angebot</strong><br /><ul><li>Sinnstiftendes Arbeitsumfeld und die Mitarbeit in einem motivierten Team</li><li>Zeitgemässe Anstellungsbedingungen</li></ul><p>Für weitere Auskünfte steht dir Vorname Nachname, Leiter Rechnungswesen, zur Verfügung.</p></div>
<div id="jet-tabs-content-9582" class="jet-tabs__content" data-tab="2" role="tabpanel" aria-hidden="true">${field('Clienia Littenheid AG')}${field('9573')}</div>
</div>
<footer>Impressum Disclaimer Datenschutz</footer>
</body></html>`;

describe('Clienia AG detail content', () => {
  it('reads the du-form sections and the paragraphs above the tabs, not the offer alone', () => {
    const text = extractCleniaDetailContent(DETAIL_HTML);

    expect(text).toMatch(/^Die Clienia-Gruppe gehört zu den grössten privaten Anbieterinnen/);
    expect(text).toContain('Arbeitsort ist Littenheid oder Oetwil am See');
    expect(text).toMatch(/Deine Aufgaben\s+• Du führst das Hauptbuch inkl\. der Kontoabstimmungen/);
    expect(text).toMatch(/Dein Profil\s+• Du verfügst über eine Weiterbildung im Finanz- und Rechnungswesen/);
    expect(text).toMatch(/Unser Angebot\s+• Sinnstiftendes Arbeitsumfeld/);
    expect(text).toContain('Für weitere Auskünfte steht dir Vorname Nachname');
    expect(text).not.toContain('Code 3136256');
    expect(text).not.toContain('Clienia Littenheid AG');
    expect(text).not.toContain('Impressum');
  });

  it('keeps the heading fallback for a page without the tab layout, du-form included', () => {
    const html = '<div><h3>Deine Aufgaben</h3><ul><li>Du betreust Patientinnen und Patienten auf der Akutstation im Nachtdienst und leitest Krisengespräche.</li></ul><h3>Dein Profil</h3><ul><li>Diplom als Pflegefachperson HF/FH</li></ul></div>';
    const text = extractCleniaDetailContent(html);

    expect(text).toMatch(/^Deine Aufgaben/);
    expect(text).toContain('Dein Profil');
  });
});
