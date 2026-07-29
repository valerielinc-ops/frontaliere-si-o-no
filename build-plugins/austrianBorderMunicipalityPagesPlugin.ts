/**
 * Per-municipality AUSTRIA border pages (issue #4883, fourth of the
 * FR/DE/AT/LI rollout after France #4545/#4878, Germany #4882, Liechtenstein
 * #4884/#3890 — Vorarlberg/Tirol corridor: Bezirke Bregenz/Dornbirn/
 * Feldkirch/Bludenz/Landeck).
 *
 * Emits, for every Austrian Gemeinde in the corridor that is ABOVE the
 * population floor (data/austrian-border-municipalities.json), a page:
 *
 *   /vivere-in-austria-lavorare-in-svizzera/{slug}/   (it, + 3 locale prefixes)
 *   "Vivere a {Gemeinde} e lavorare in Svizzera: nessun regime frontalieri per l'Austria"
 *
 * GOVERNING FISCAL FACT (see austrianBorderMunicipalityData.ts's
 * AUSTRIAN_REGIME for the full sourcing): the special Art. 15 §4 DBA-A
 * frontalieri regime was ABROGATED in 2006/2007. There is NO reduced rate,
 * NO defined border zone and NO non-return-days threshold — ordinary Art. 15
 * §1 taxation (full cantonal Quellensteuer) applies to any Austria-resident
 * working in Switzerland. This is the single most important fact this page
 * family communicates: a reader arriving from the German or Liechtenstein
 * corridor pages will otherwise wrongly assume one of those regimes'
 * thresholds applies here too. The copy below actively DENIES that
 * expectation without restating the sibling regimes' specific figures (no
 * "4.5%"/"4,5%", no "60 giorni"/"60 Arbeitstage" anywhere in this file) —
 * tests/austrian-border-municipality-pages.test.ts asserts their absence.
 * The unverified ~9,000 frontalieri estimate (mysalario.ch, no official
 * anchor) is likewise never emitted.
 *
 * Gemeinden BELOW the floor get a noindex,follow bridge at the SAME URL
 * (never a silent 404 — AGENTS.md § Static SEO Pages), paired with the
 * self-map in build-plugins/searchConsoleCompat.ts.
 *
 * Architectural note: follows the FRANCE/FISCAL page pattern deliberately
 * (see austrianBorderMunicipalityData.ts header) — self-contained module, no
 * hubChrome, no bespoke locale-rewrite in services/router.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { resolveAustrianBorderMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { getCantonDisplayName } from './shared/cantonDisplay';
import {
  AUSTRIAN_LOCALES,
  AUSTRIAN_ABOVE_FLOOR,
  AUSTRIAN_BELOW_FLOOR,
  AUSTRIAN_HUB_PATH,
  AUSTRIAN_REGIME,
  austrianMunicipalityPathFor,
  type AustrianLocale,
  type AustrianBorderMunicipality,
  type AustrianBezirk,
} from './austrianBorderMunicipalityData';

const OG_LOCALE: Record<AustrianLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SITEMAP_NAME = 'sitemap-comuni-austria.xml';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intlLang(locale: AustrianLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}
function intFmt(n: number, locale: AustrianLocale): string {
  return new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 0 }).format(n);
}

// Derived from AUSTRIAN_REGIME's sourced decimal values, never a second
// hard-coded literal of the same number (drift-safe) — mirrors
// germanBorderMunicipalityPagesPlugin.ts's TAX_RATE_STR pattern.
const COMP_RATE_STR = `${(AUSTRIAN_REGIME.interStateCompensationRate * 100).toFixed(1)}%`;
const TELEWORK_STR = `${(AUSTRIAN_REGIME.teleworkSocialSecurityThreshold * 100).toFixed(1)}%`;
const OECD_DAYS = AUSTRIAN_REGIME.oecdShortStayThresholdDays;
const ABROGATED_YEAR = AUSTRIAN_REGIME.abrogatedEffectiveYear;
const ABROGATED_PUBLISHED = AUSTRIAN_REGIME.abrogatedPublishedYear;
const TELEWORK_EFFECTIVE = AUSTRIAN_REGIME.teleworkFrameworkEffectiveDate;

// ── Localized copy ──────────────────────────────────────────────

interface Copy {
  role: string;
  updated: string;
  home: string;
  hubLabel: string;
  h1: (n: string) => string;
  title: (n: string) => string;
  titleMid: (n: string) => string;
  titleShort: (n: string) => string;
  desc: (n: string) => string;
  lede: (n: string) => string;
  tilePop: string;
  tileDistance: string;
  tileBezirk: string;
  tileRegime: string;
  tileRegimeValue: string;
  distanceUnit: string;
  explainAbrogationTitle: string;
  explainAbrogation: (n: string) => string;
  explainNoCapTitle: string;
  explainNoCap: string;
  explainCreditTitle: string;
  explainCredit: string;
  explainTeleworkTitle: string;
  explainTelework: string;
  explainFlowTitle: string;
  explainFlow: string;
  crossTitle: string;
  calcLink: string;
  relatedTitle: string;
  faqTitle: string;
  faqQ1: (n: string) => string;
  faqA1: (n: string) => string;
  faqQ2: string;
  faqA2: string;
  faqQ3: string;
  faqA3: string;
  faqQ4: string;
  faqA4: string;
  disclaimer: string;
  hubTitle: string;
  hubLede: string;
  groupBezirk: (bezirk: string) => string;
  bridgeLede: (n: string) => string;
}

const COPY: Record<AustrianLocale, Copy> = {
  it: {
    role: 'Guida frontalieri',
    updated: 'Aggiornato',
    home: 'Home',
    hubLabel: 'Vivere in Austria e lavorare in Svizzera',
    h1: (n) => `Vivere a ${n} e lavorare in Svizzera: nessun regime frontalieri per l'Austria`,
    title: (n) => `Vivere a ${n} e lavorare in Svizzera`,
    titleMid: (n) => `${n}: lavorare in Svizzera dall'Austria`,
    titleShort: (n) => `Vivere a ${n}`,
    desc: (n) => `Tassazione ordinaria, nessun regime frontalieri agevolato per chi vive a ${n} e lavora in Svizzera: cosa è cambiato dal ${ABROGATED_YEAR}.`,
    lede: (n) =>
      `${n} non rientra in alcun regime frontalieri agevolato: l'art. 15 §4 DBA-A è stato abrogato dal ${ABROGATED_YEAR} (pubblicato ${ABROGATED_PUBLISHED}). Chi vive a ${n} e lavora in Svizzera paga la tariffa cantonale Quellensteuer piena, come qualunque altro lavoratore tassato alla fonte, senza riduzioni né soglie di distanza.`,
    tilePop: 'Popolazione',
    tileDistance: 'Distanza dal valico',
    tileBezirk: 'Bezirk',
    tileRegime: 'Regime fiscale',
    tileRegimeValue: 'Tariffa piena',
    distanceUnit: 'km',
    explainAbrogationTitle: 'Perché non esiste un regime frontalieri',
    explainAbrogation: (n) =>
      `Fino al ${ABROGATED_YEAR} l'Austria aveva un proprio regime frontalieri (art. 15 §4 DBA-A, SR 0.672.916.31), con una ritenuta ridotta sul reddito. Quel regime è stato abrogato (BGBl. III Nr. 22/2007, "aufgehoben") e da allora si applica la regola ordinaria dell'art. 15 §1: chiunque lavori in Svizzera, incluso chi vive a ${n}, è tassato con la tariffa cantonale Quellensteuer piena nello Stato di lavoro. Non esiste una zona di confine definita: la regola vale per qualunque residente austriaco, a prescindere dalla distanza dal confine.`,
    explainNoCapTitle: 'Nessun tetto ridotto, nessuna soglia di giorni',
    explainNoCap:
      "A differenza del corridoio con la Germania, che prevede una ritenuta ridotta sul reddito lordo, per l'Austria non esiste alcuna riduzione: si applica sempre la tariffa piena. E a differenza dei corridoi con la Germania o con il Liechtenstein, qui non esiste nemmeno una soglia di giorni di non rientro da rispettare: non c'è uno status di frontaliere da perdere. Esiste solo la regola generale OCSE per le missioni brevi (art. 15 §2, una soglia di " +
      `${OECD_DAYS} giorni), che riguarda i soggiorni di lavoro occasionali e non ha nulla a che vedere con il pendolarismo transfrontaliero regolare.`,
    explainCreditTitle: 'Come si evita la doppia imposizione',
    explainCredit:
      `L'Austria evita la doppia imposizione con il metodo del credito (Anrechnungsmethode, art. 23 §2): l'imposta pagata in Svizzera viene scontata dall'imposta austriaca dovuta sullo stesso reddito, invece del metodo dell'esenzione che l'Austria usa come regola generale in altri casi. In cambio dell'assenza di uno sgravio individuale sul lato svizzero, i cantoni svizzeri versano collettivamente all'erario austriaco una compensazione pari al ${COMP_RATE_STR} del gettito della Quellensteuer riscossa ai sensi dell'art. 15 §1 (Protocollo finale, punto 4).`,
    explainTeleworkTitle: `Telelavoro: la soglia previdenziale del ${TELEWORK_STR}`,
    explainTelework:
      `Per chi lavora parzialmente da casa si applica una soglia previdenziale, non fiscale: superare il ${TELEWORK_STR} del tempo di lavoro svolto dal proprio Stato di domicilio fa cambiare lo Stato competente per i contributi sociali (accordo quadro UE-EFTA ex art. 16(1) Reg. 883/2004, in vigore dal ${TELEWORK_EFFECTIVE} sia per l'Austria sia per la Svizzera). Non risulta invece alcun accordo fiscale bilaterale specifico sul telelavoro tra i due Paesi.`,
    explainFlowTitle: 'La direzione del pendolarismo',
    explainFlow:
      'Diversamente dal corridoio con il Liechtenstein — oggi a maggioranza Svizzera → Liechtenstein — qui il flusso segue la direzione abituale: dall\'Austria verso i cantoni svizzeri di lavoro (San Gallo e Grigioni).',
    crossTitle: 'Approfondimenti utili',
    calcLink: 'Calcola il tuo stipendio netto',
    relatedTitle: 'Altri comuni del corridoio',
    faqTitle: 'Domande frequenti',
    faqQ1: (n) => `Che regime fiscale si applica a ${n}?`,
    faqA1: (n) => `${n} segue la regola ordinaria dell'art. 15 §1 DBA-A: tariffa cantonale Quellensteuer piena nello Stato di lavoro, senza riduzioni. Il vecchio regime frontalieri (art. 15 §4) è abrogato dal ${ABROGATED_YEAR}.`,
    faqQ2: 'È vero che vale lo stesso tetto ridotto del corridoio tedesco?',
    faqA2:
      "No. Quel tetto ridotto riguarda solo il corridoio con la Germania. Per l'Austria non esiste alcuna riduzione della ritenuta: si applica sempre la tariffa cantonale piena.",
    faqQ3: 'Esiste una soglia di giorni di non rientro come per Germania o Liechtenstein?',
    faqA3:
      `No. Non essendoci uno status di frontaliere, non c'è nessuna soglia di giorni di non rientro da rispettare. Esiste solo la regola OCSE generale sulle missioni brevi (art. 15 §2, ${OECD_DAYS} giorni), che non è legata al pendolarismo transfrontaliero.`,
    faqQ4: 'Il telelavoro cambia qualcosa?',
    faqA4:
      `Sul piano previdenziale sì: oltre il ${TELEWORK_STR} del tempo lavorato da casa lo Stato competente per i contributi può cambiare (accordo quadro UE-EFTA). Sul piano fiscale non risulta un accordo bilaterale specifico: verifica sempre con il tuo cantone di impiego.`,
    disclaimer:
      'Stime a scopo orientativo. La tassazione effettiva dipende da situazione familiare, deduzioni e certificazioni. Verifica sempre con un consulente fiscale o con il cantone di impiego.',
    hubTitle: 'Vivere in Austria e lavorare in Svizzera, comune per comune',
    hubLede:
      `Nessun regime frontalieri agevolato: dal ${ABROGATED_YEAR} si applica la tariffa cantonale Quellensteuer piena (art. 15 §1), con il metodo del credito per evitare la doppia imposizione e una compensazione inter-statale del ${COMP_RATE_STR} versata dai cantoni svizzeri. Pagine comune per comune per il corridoio Vorarlberg/Tirol (Bregenz, Dornbirn, Feldkirch, Bludenz, Landeck).`,
    groupBezirk: (b) => `Bezirk ${b}`,
    bridgeLede: (n) =>
      `${n} è nel corridoio di confine ma sotto la soglia di popolazione: la guida dedicata non è ancora pubblicata. Anche qui non esiste comunque alcun regime frontalieri agevolato: si applica la tariffa cantonale piena. Usa il calcolatore o esplora i comuni principali del corridoio.`,
  },
  en: {
    role: 'Cross-border guide',
    updated: 'Updated',
    home: 'Home',
    hubLabel: 'Living in Austria, working in Switzerland',
    h1: (n) => `Living in ${n} and working in Switzerland: no cross-border regime for Austria`,
    title: (n) => `Living in ${n}, working in Switzerland`,
    titleMid: (n) => `${n}: working in Switzerland from Austria`,
    titleShort: (n) => `Living in ${n}`,
    desc: (n) => `Ordinary taxation, no favourable cross-border regime for residents of ${n} working in Switzerland: what changed in ${ABROGATED_YEAR}.`,
    lede: (n) =>
      `${n} does not fall under any favourable cross-border regime: §15(4) DBA-A was abolished in ${ABROGATED_YEAR} (published ${ABROGATED_PUBLISHED}). Residents of ${n} working in Switzerland pay the full cantonal withholding tax, like any other source-taxed worker, with no reduction and no distance threshold.`,
    tilePop: 'Population',
    tileDistance: 'Distance to crossing',
    tileBezirk: 'District (Bezirk)',
    tileRegime: 'Tax regime',
    tileRegimeValue: 'Full rate',
    distanceUnit: 'km',
    explainAbrogationTitle: 'Why there is no cross-border regime',
    explainAbrogation: (n) =>
      `Until ${ABROGATED_YEAR}, Austria had its own cross-border regime (§15(4) DBA-A, SR 0.672.916.31) with a reduced withholding on income. That regime was abolished (BGBl. III Nr. 22/2007, "aufgehoben"), and since then the ordinary §15(1) rule applies: anyone working in Switzerland, including residents of ${n}, is taxed at the full cantonal withholding rate in the state of work. There is no defined border zone — the rule applies to any Austrian resident, regardless of distance from the border.`,
    explainNoCapTitle: 'No reduced cap, no day threshold',
    explainNoCap:
      `Unlike the corridor with Germany, which applies a reduced withholding on gross pay, Austria has no such reduction: the full rate always applies. And unlike the corridors with Germany or Liechtenstein, there is no non-return-day threshold to respect either — there is no cross-border status to lose. Only the general OECD short-stay rule exists (§15(2), a ${OECD_DAYS}-day threshold), which covers occasional short work stays and has nothing to do with regular cross-border commuting.`,
    explainCreditTitle: 'How double taxation is avoided',
    explainCredit:
      `Austria avoids double taxation via the credit method (Anrechnungsmethode, Art. 23(2)): tax paid in Switzerland is credited against the Austrian tax due on the same income, instead of the exemption method Austria otherwise uses as its general rule. In place of an individual relief on the Swiss side, Swiss cantons collectively pay Austria's treasury a compensation equal to ${COMP_RATE_STR} of the withholding-tax revenue collected under §15(1) (Final Protocol, point 4).`,
    explainTeleworkTitle: `Telework: the ${TELEWORK_STR} social-security threshold`,
    explainTelework:
      `For those working partly from home, a social-security (not fiscal) threshold applies: exceeding ${TELEWORK_STR} of working time performed from your state of residence changes which state is responsible for social-security contributions (EU/EFTA multilateral framework agreement under Art. 16(1) Reg. 883/2004, in force since ${TELEWORK_EFFECTIVE} for both Austria and Switzerland). No specific bilateral fiscal telework agreement was found.`,
    explainFlowTitle: 'The direction of commuting',
    explainFlow:
      'Unlike the corridor with Liechtenstein — today mostly Switzerland → Liechtenstein — here the flow runs the usual way: from Austria towards the Swiss cantons of employment (St. Gallen and Graubünden).',
    crossTitle: 'Useful reading',
    calcLink: 'Calculate your net salary',
    relatedTitle: 'Other towns in the corridor',
    faqTitle: 'FAQ',
    faqQ1: (n) => `Which tax regime applies in ${n}?`,
    faqA1: (n) => `${n} follows the ordinary §15(1) DBA-A rule: full cantonal withholding tax in the state of work, with no reduction. The former cross-border regime (§15(4)) has been abolished since ${ABROGATED_YEAR}.`,
    faqQ2: 'Does the same reduced cap as the German corridor apply here?',
    faqA2: 'No. That reduced cap applies only to the corridor with Germany. Austria has no reduction to the withholding tax at all: the full cantonal rate always applies.',
    faqQ3: 'Is there a non-return-day threshold like Germany or Liechtenstein?',
    faqA3:
      `No. Since there is no cross-border status, there is no non-return-day threshold to respect. Only the general OECD short-stay rule exists (§15(2), ${OECD_DAYS} days), which is unrelated to cross-border commuting.`,
    faqQ4: 'Does telework change anything?',
    faqA4:
      `On social security, yes: beyond ${TELEWORK_STR} of working time from home, the state responsible for contributions can change (EU/EFTA framework agreement). On taxation, no specific bilateral agreement was found: always check with your canton of employment.`,
    disclaimer:
      'Estimates for guidance only. Actual taxation depends on family situation, deductions and certificates. Always check with a tax adviser or your canton of employment.',
    hubTitle: 'Living in Austria, working in Switzerland, town by town',
    hubLede:
      `No favourable cross-border regime: since ${ABROGATED_YEAR} the full cantonal withholding tax applies (§15(1)), with the credit method to avoid double taxation and a ${COMP_RATE_STR} inter-state compensation paid by Swiss cantons. Town-by-town pages for the Vorarlberg/Tirol corridor (Bregenz, Dornbirn, Feldkirch, Bludenz, Landeck).`,
    groupBezirk: (b) => `District of ${b}`,
    bridgeLede: (n) =>
      `${n} is in the border corridor but below the population floor, so its dedicated guide is not published yet. Here too there is no favourable cross-border regime: the full cantonal rate applies. Use the calculator or explore the main towns in the corridor.`,
  },
  de: {
    role: 'Grenzgänger-Ratgeber',
    updated: 'Aktualisiert',
    home: 'Startseite',
    hubLabel: 'In Österreich leben, in der Schweiz arbeiten',
    h1: (n) => `Leben in ${n} und Arbeiten in der Schweiz: kein Grenzgänger-Regime für Österreich`,
    title: (n) => `Leben in ${n}, Arbeiten in der Schweiz`,
    titleMid: (n) => `${n}: Arbeiten in der Schweiz aus Österreich`,
    titleShort: (n) => `Leben in ${n}`,
    desc: (n) => `Ordentliche Besteuerung, kein begünstigtes Grenzgänger-Regime für Einwohner von ${n}, die in der Schweiz arbeiten: was sich seit ${ABROGATED_YEAR} geändert hat.`,
    lede: (n) =>
      `${n} fällt unter kein begünstigtes Grenzgänger-Regime: Art. 15 Abs. 4 DBA-A wurde ${ABROGATED_YEAR} aufgehoben (veröffentlicht ${ABROGATED_PUBLISHED}). Wer in ${n} wohnt und in der Schweiz arbeitet, zahlt die volle kantonale Quellensteuer wie jeder andere an der Quelle besteuerte Arbeitnehmer, ohne Ermässigung und ohne Distanzschwelle.`,
    tilePop: 'Einwohner',
    tileDistance: 'Distanz zum Grenzübergang',
    tileBezirk: 'Bezirk',
    tileRegime: 'Steuerregime',
    tileRegimeValue: 'Voller Satz',
    distanceUnit: 'km',
    explainAbrogationTitle: 'Warum es kein Grenzgänger-Regime gibt',
    explainAbrogation: (n) =>
      `Bis ${ABROGATED_YEAR} hatte Österreich ein eigenes Grenzgänger-Regime (Art. 15 Abs. 4 DBA-A, SR 0.672.916.31) mit einem ermässigten Steuerabzug. Dieses Regime wurde aufgehoben (BGBl. III Nr. 22/2007, "aufgehoben"), seither gilt die ordentliche Regel nach Art. 15 Abs. 1: Wer in der Schweiz arbeitet, einschliesslich Einwohner von ${n}, wird mit dem vollen kantonalen Quellensteuersatz im Tätigkeitsstaat besteuert. Es gibt keine definierte Grenzzone — die Regel gilt für jeden österreichischen Einwohner, unabhängig von der Distanz zur Grenze.`,
    explainNoCapTitle: 'Kein ermässigter Satz, keine Tagesschwelle',
    explainNoCap:
      `Anders als im Korridor mit Deutschland, wo ein ermässigter Steuerabzug auf das Bruttoeinkommen gilt, kennt Österreich keine solche Ermässigung: Es gilt immer der volle Satz. Und anders als in den Korridoren mit Deutschland oder Liechtenstein gibt es hier auch keine Nichtrückkehrtage-Schwelle zu beachten — es gibt keinen Grenzgängerstatus, der verloren gehen könnte. Es gilt nur die allgemeine OECD-Regel für Kurzaufenthalte (Art. 15 Abs. 2, eine ${OECD_DAYS}-Tage-Schwelle), die gelegentliche kurze Arbeitsaufenthalte betrifft und nichts mit regelmässigem Grenzpendeln zu tun hat.`,
    explainCreditTitle: 'Wie die Doppelbesteuerung vermieden wird',
    explainCredit:
      `Österreich vermeidet die Doppelbesteuerung durch die Anrechnungsmethode (Art. 23 Abs. 2): Die in der Schweiz gezahlte Steuer wird auf die österreichische Steuer für dasselbe Einkommen angerechnet, statt der Befreiungsmethode, die Österreich sonst als allgemeine Regel anwendet. Anstelle einer individuellen Entlastung auf Schweizer Seite zahlen die Schweizer Kantone gemeinsam eine Ausgleichszahlung von ${COMP_RATE_STR} des nach Art. 15 Abs. 1 erhobenen Quellensteueraufkommens an die österreichische Staatskasse (Schlussprotokoll, Ziffer 4).`,
    explainTeleworkTitle: `Homeoffice: die ${TELEWORK_STR}-Sozialversicherungsschwelle`,
    explainTelework:
      `Für alle, die teilweise im Homeoffice arbeiten, gilt eine sozialversicherungsrechtliche — nicht steuerliche — Schwelle: Wer mehr als ${TELEWORK_STR} der Arbeitszeit vom Wohnsitzstaat aus leistet, für den kann sich der für die Sozialversicherung zuständige Staat ändern (multilaterales EU/EFTA-Rahmenabkommen nach Art. 16 Abs. 1 VO 883/2004, in Kraft seit ${TELEWORK_EFFECTIVE} für Österreich und die Schweiz). Ein spezifisches bilaterales Steuerabkommen zum Homeoffice wurde nicht gefunden.`,
    explainFlowTitle: 'Die Pendelrichtung',
    explainFlow:
      'Anders als im Korridor mit Liechtenstein — heute überwiegend Schweiz → Liechtenstein — verläuft der Pendlerstrom hier in die übliche Richtung: von Österreich zu den Schweizer Beschäftigungskantonen (St. Gallen und Graubünden).',
    crossTitle: 'Nützliche Lektüre',
    calcLink: 'Nettolohn berechnen',
    relatedTitle: 'Weitere Orte im Korridor',
    faqTitle: 'Häufige Fragen',
    faqQ1: (n) => `Welches Steuerregime gilt in ${n}?`,
    faqA1: (n) => `${n} folgt der ordentlichen Regel nach Art. 15 Abs. 1 DBA-A: voller kantonaler Quellensteuersatz im Tätigkeitsstaat, ohne Ermässigung. Das frühere Grenzgänger-Regime (Art. 15 Abs. 4) ist seit ${ABROGATED_YEAR} aufgehoben.`,
    faqQ2: 'Gilt hier derselbe ermässigte Satz wie im deutschen Korridor?',
    faqA2: 'Nein. Dieser ermässigte Satz gilt nur für den Korridor mit Deutschland. Für Österreich gibt es keine Ermässigung der Quellensteuer: Es gilt immer der volle kantonale Satz.',
    faqQ3: 'Gibt es eine Nichtrückkehrtage-Schwelle wie in Deutschland oder Liechtenstein?',
    faqA3:
      `Nein. Da es keinen Grenzgängerstatus gibt, gibt es auch keine Nichtrückkehrtage-Schwelle zu beachten. Es gilt nur die allgemeine OECD-Regel für Kurzaufenthalte (Art. 15 Abs. 2, ${OECD_DAYS} Tage), die nichts mit Grenzpendeln zu tun hat.`,
    faqQ4: 'Ändert Homeoffice etwas?',
    faqA4:
      `Sozialversicherungsrechtlich ja: Wer mehr als ${TELEWORK_STR} der Arbeitszeit im Homeoffice leistet, für den kann sich der zuständige Staat für die Beiträge ändern (EU/EFTA-Rahmenabkommen). Steuerlich wurde kein spezifisches bilaterales Abkommen gefunden: Prüfen Sie dies immer mit Ihrem Beschäftigungskanton.`,
    disclaimer:
      'Schätzungen nur zur Orientierung. Die tatsächliche Besteuerung hängt von Familiensituation, Abzügen und Bescheinigungen ab. Immer mit einer Steuerberatung oder dem Beschäftigungskanton prüfen.',
    hubTitle: 'In Österreich leben, in der Schweiz arbeiten, Ort für Ort',
    hubLede:
      `Kein begünstigtes Grenzgänger-Regime: Seit ${ABROGATED_YEAR} gilt die volle kantonale Quellensteuer (Art. 15 Abs. 1), mit der Anrechnungsmethode zur Vermeidung der Doppelbesteuerung und einer Ausgleichszahlung von ${COMP_RATE_STR}, die von den Schweizer Kantonen getragen wird. Orts-für-Ort-Seiten für den Korridor Vorarlberg/Tirol (Bregenz, Dornbirn, Feldkirch, Bludenz, Landeck).`,
    groupBezirk: (b) => `Bezirk ${b}`,
    bridgeLede: (n) =>
      `${n} liegt im Grenzkorridor, aber unterhalb der Bevölkerungsschwelle, daher ist der eigene Ratgeber noch nicht veröffentlicht. Auch hier gibt es kein begünstigtes Grenzgänger-Regime: Es gilt der volle kantonale Satz. Nutzen Sie den Rechner oder erkunden Sie die grösseren Orte im Korridor.`,
  },
  fr: {
    role: 'Guide frontalier',
    updated: 'Mis à jour',
    home: 'Accueil',
    hubLabel: "Vivre en Autriche, travailler en Suisse",
    h1: (n) => `Vivre à ${n} et travailler en Suisse : aucun régime frontalier pour l'Autriche`,
    title: (n) => `Vivre à ${n}, travailler en Suisse`,
    titleMid: (n) => `${n} : travailler en Suisse depuis l'Autriche`,
    titleShort: (n) => `Vivre à ${n}`,
    desc: (n) => `Fiscalité ordinaire, aucun régime frontalier favorable pour les habitants de ${n} qui travaillent en Suisse : ce qui a changé en ${ABROGATED_YEAR}.`,
    lede: (n) =>
      `${n} ne relève d'aucun régime frontalier favorable : l'art. 15 § 4 CDI-A a été abrogé en ${ABROGATED_YEAR} (publié en ${ABROGATED_PUBLISHED}). Les habitants de ${n} qui travaillent en Suisse paient l'impôt à la source cantonal plein, comme tout autre travailleur imposé à la source, sans réduction ni seuil de distance.`,
    tilePop: 'Population',
    tileDistance: 'Distance à la frontière',
    tileBezirk: 'District (Bezirk)',
    tileRegime: 'Régime fiscal',
    tileRegimeValue: 'Taux plein',
    distanceUnit: 'km',
    explainAbrogationTitle: "Pourquoi il n'y a pas de régime frontalier",
    explainAbrogation: (n) =>
      `Jusqu'en ${ABROGATED_YEAR}, l'Autriche disposait de son propre régime frontalier (art. 15 § 4 CDI-A, SR 0.672.916.31), avec une retenue réduite sur le revenu. Ce régime a été abrogé (BGBl. III Nr. 22/2007, « aufgehoben »), et depuis lors la règle ordinaire de l'art. 15 § 1 s'applique : quiconque travaille en Suisse, y compris les habitants de ${n}, est imposé au taux cantonal plein dans l'État d'activité. Il n'existe aucune zone frontalière définie : la règle s'applique à tout résident autrichien, quelle que soit la distance à la frontière.`,
    explainNoCapTitle: 'Aucun taux réduit, aucun seuil de jours',
    explainNoCap:
      `Contrairement au corridor avec l'Allemagne, qui applique une retenue réduite sur le salaire brut, l'Autriche ne connaît aucune réduction de ce type : le taux plein s'applique toujours. Et contrairement aux corridors avec l'Allemagne ou le Liechtenstein, il n'existe ici non plus aucun seuil de jours de non-retour à respecter — il n'y a pas de statut de frontalier à perdre. Seule existe la règle générale de l'OCDE pour les courts séjours (art. 15 § 2, un seuil de ${OECD_DAYS} jours), qui concerne les missions occasionnelles de courte durée et n'a rien à voir avec la pendularité frontalière régulière.`,
    explainCreditTitle: 'Comment la double imposition est évitée',
    explainCredit:
      `L'Autriche évite la double imposition par la méthode de l'imputation (Anrechnungsmethode, art. 23 § 2) : l'impôt payé en Suisse est imputé sur l'impôt autrichien dû sur le même revenu, au lieu de la méthode de l'exemption que l'Autriche applique par ailleurs comme règle générale. En l'absence d'un allègement individuel côté suisse, les cantons suisses versent collectivement au Trésor autrichien une compensation égale à ${COMP_RATE_STR} des recettes de l'impôt à la source perçu en vertu de l'art. 15 § 1 (protocole final, point 4).`,
    explainTeleworkTitle: `Télétravail : le seuil de sécurité sociale de ${TELEWORK_STR}`,
    explainTelework:
      `Pour les personnes travaillant partiellement depuis leur domicile, un seuil relève de la sécurité sociale — pas de la fiscalité : dépasser ${TELEWORK_STR} du temps de travail effectué depuis l'État de résidence peut changer l'État compétent pour les cotisations sociales (accord-cadre multilatéral UE-AELE au titre de l'art. 16 § 1 du règl. 883/2004, en vigueur depuis le ${TELEWORK_EFFECTIVE} pour l'Autriche comme pour la Suisse). Aucun accord fiscal bilatéral spécifique sur le télétravail n'a été trouvé.`,
    explainFlowTitle: 'Le sens de la pendularité',
    explainFlow:
      "Contrairement au corridor avec le Liechtenstein — aujourd'hui majoritairement Suisse → Liechtenstein — le flux suit ici le sens habituel : de l'Autriche vers les cantons suisses d'emploi (Saint-Gall et les Grisons).",
    crossTitle: 'À lire aussi',
    calcLink: 'Calculez votre salaire net',
    relatedTitle: 'Autres communes du corridor',
    faqTitle: 'Questions fréquentes',
    faqQ1: (n) => `Quel régime fiscal s'applique à ${n} ?`,
    faqA1: (n) => `${n} suit la règle ordinaire de l'art. 15 § 1 CDI-A : impôt à la source cantonal plein dans l'État d'activité, sans réduction. L'ancien régime frontalier (art. 15 § 4) est abrogé depuis ${ABROGATED_YEAR}.`,
    faqQ2: "Le même taux réduit que le corridor allemand s'applique-t-il ici ?",
    faqA2:
      "Non. Ce taux réduit ne concerne que le corridor avec l'Allemagne. Pour l'Autriche, il n'existe aucune réduction de l'impôt à la source : le taux cantonal plein s'applique toujours.",
    faqQ3: "Existe-t-il un seuil de jours de non-retour comme pour l'Allemagne ou le Liechtenstein ?",
    faqA3:
      `Non. En l'absence de statut de frontalier, il n'y a aucun seuil de jours de non-retour à respecter. Seule existe la règle générale de l'OCDE pour les courts séjours (art. 15 § 2, ${OECD_DAYS} jours), sans lien avec la pendularité frontalière.`,
    faqQ4: 'Le télétravail change-t-il quelque chose ?',
    faqA4:
      `Sur le plan de la sécurité sociale, oui : au-delà de ${TELEWORK_STR} du temps de travail effectué depuis le domicile, l'État compétent pour les cotisations peut changer (accord-cadre UE-AELE). Sur le plan fiscal, aucun accord bilatéral spécifique n'a été trouvé : vérifiez toujours auprès de votre canton d'emploi.`,
    disclaimer:
      "Estimations à titre indicatif. L'imposition réelle dépend de la situation familiale, des déductions et des attestations. Vérifiez toujours avec un conseiller fiscal ou le canton d'emploi.",
    hubTitle: 'Vivre en Autriche, travailler en Suisse, commune par commune',
    hubLede:
      `Aucun régime frontalier favorable : depuis ${ABROGATED_YEAR}, l'impôt à la source cantonal plein s'applique (art. 15 § 1), avec la méthode de l'imputation pour éviter la double imposition et une compensation inter-étatique de ${COMP_RATE_STR} versée par les cantons suisses. Pages commune par commune pour le corridor Vorarlberg/Tyrol (Bregenz, Dornbirn, Feldkirch, Bludenz, Landeck).`,
    groupBezirk: (b) => `District de ${b}`,
    bridgeLede: (n) =>
      `${n} se trouve dans le corridor frontalier mais sous le seuil de population : son guide dédié n'est pas encore publié. Là aussi, aucun régime frontalier favorable : le taux cantonal plein s'applique. Utilisez le calculateur ou explorez les principales communes du corridor.`,
  },
};

const CALC_PATH: Record<AustrianLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── hreflang / breadcrumb ───────────────────────────────────────

function hreflangFor(slug: string, locales: readonly AustrianLocale[] = AUSTRIAN_LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${austrianMunicipalityPathFor(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${austrianMunicipalityPathFor('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: AustrianLocale, name: string, canonicalUrl: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: COPY[locale].home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: COPY[locale].hubLabel, item: `${BASE_URL}${AUSTRIAN_HUB_PATH[locale]}` },
      { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
    ],
  });
}

// ── Page renderers ──────────────────────────────────────────────

function renderRelated(locale: AustrianLocale, current: AustrianBorderMunicipality): string {
  const others = AUSTRIAN_ABOVE_FLOOR.filter((m) => m.slug !== current.slug).slice(0, 6);
  if (others.length === 0) return '';
  const links = others
    .map(
      (m) =>
        `<a class="rounded-md border border-edge bg-surface-raised p-3 text-sm font-semibold text-heading hover:border-accent-border" href="${austrianMunicipalityPathFor(locale, m.slug)}">${esc(m.name)} <span class="font-normal text-muted">· ${esc(getCantonDisplayName(m.canton, locale))}</span></a>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(COPY[locale].relatedTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    </section>`;
}

export function renderAboveFloorPage(params: {
  municipality: AustrianBorderMunicipality;
  locale: AustrianLocale;
  dateStamp: string;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const canonicalPath = austrianMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const tile = (label: string, value: string, sub: string) =>
    `<div class="rounded-md border border-edge bg-surface p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(label)}</dt>
        <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
        <dd class="mt-0.5 text-xs text-subtle">${esc(sub)}</dd>
      </div>`;

  const body = `<div class="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${AUSTRIAN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(c.role)}</span>
        <span class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-subtle">${esc(municipality.bezirk)} · ${esc(getCantonDisplayName(municipality.canton, locale))} · ${esc(municipality.nearestCrossing)}</span>
      </div>
      <h1 class="mt-4 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.h1(n))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.lede(n))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tilePop, intFmt(municipality.population, locale), '')}
      ${tile(c.tileDistance, `${intFmt(municipality.distanceKm, locale)} ${c.distanceUnit}`, municipality.nearestCrossing)}
      ${tile(c.tileBezirk, municipality.bezirk, municipality.land)}
      ${tile(c.tileRegime, c.tileRegimeValue, 'Art. 15 §1')}
    </dl>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainAbrogationTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainAbrogation(n))}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainNoCapTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainNoCap)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainCreditTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainCredit)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainTeleworkTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainTelework)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainFlowTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainFlow)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${CALC_PATH[locale]}">${esc(c.calcLink)}</a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${AUSTRIAN_HUB_PATH[locale]}">${esc(c.hubTitle)}</a>
      </div>
    </section>

    ${renderRelated(locale, municipality)}

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">
        <details class="py-3" open><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ1(n))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA1(n))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ2)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA2)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ3)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA3)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ4)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA4)}</p></details>
      </div>
    </section>

    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: c.faqQ1(n), acceptedAnswer: { '@type': 'Answer', text: c.faqA1(n) } },
      { '@type': 'Question', name: c.faqQ2, acceptedAnswer: { '@type': 'Answer', text: c.faqA2 } },
      { '@type': 'Question', name: c.faqQ3, acceptedAnswer: { '@type': 'Answer', text: c.faqA3 } },
      { '@type': 'Question', name: c.faqQ4, acceptedAnswer: { '@type': 'Answer', text: c.faqA4 } },
    ],
  });

  // Budget-aware, keyword-preserving cascade (composePlaceTitle) — three
  // rungs, longest-first (issue #4886): `title` (full sentence) →
  // `titleMid` (name + role) → `titleShort` (the shortest form that still
  // carries this locale's core "living in {name}" keyword). The bare
  // Gemeinde name is NEVER a candidate.
  const titleCandidates = [c.title(n), c.titleMid(n), c.titleShort(n)];
  const html = buildSeoPageHtml({
    locale,
    title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
    description: c.desc(n),
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl), faqLd],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html, wordCount };
}

export function renderBridgePage(params: {
  municipality: AustrianBorderMunicipality;
  locale: AustrianLocale;
  distDir: string;
}): string {
  const { municipality, locale, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const canonicalPath = austrianMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const body = `<main class="seo-static-content mx-auto max-w-[760px] px-5 pt-8 pb-14 text-body">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${AUSTRIAN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>
    <h1 class="text-2xl font-bold text-heading mb-3">${esc(c.h1(n))}</h1>
    <p class="text-body mb-5 leading-6">${esc(c.bridgeLede(n))}</p>
    <ul class="space-y-2 list-none p-0 m-0">
      <li><a href="${CALC_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a></li>
      <li><a href="${AUSTRIAN_HUB_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.hubTitle)} →</a></li>
    </ul>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: c.title(n),
    description: c.desc(n),
    canonicalUrl,
    robots: 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl)],
    bodyHtml: body,
    distDir,
    skipMainWrap: true,
  });
}

function renderHubPage(params: { locale: AustrianLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const canonicalPath = AUSTRIAN_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const byBezirk = new Map<AustrianBezirk, AustrianBorderMunicipality[]>();
  for (const m of AUSTRIAN_ABOVE_FLOOR) {
    const arr = byBezirk.get(m.bezirk);
    if (arr) arr.push(m);
    else byBezirk.set(m.bezirk, [m]);
  }
  const groups = [...byBezirk.entries()]
    .map(([bezirk, list]) => {
      const cards = list
        .map(
          (m) =>
            `<a class="rounded-md border border-edge bg-surface-raised p-4 hover:border-accent-border" href="${austrianMunicipalityPathFor(locale, m.slug)}">
              <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
              <span class="mt-1 block text-xs text-muted">${esc(getCantonDisplayName(m.canton, locale))}</span>
            </a>`,
        )
        .join('');
      return `<div class="mt-5">
          <h2 class="text-lg font-bold text-heading">${esc(c.groupBezirk(bezirk))}</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
        </div>`;
    })
    .join('');

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <span>${esc(c.hubLabel)}</span>
    </nav>
    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7">
      <h1 class="text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.hubTitle)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>
    ${groups}
    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const hubHreflang = AUSTRIAN_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${AUSTRIAN_HUB_PATH[alt]}">`,
  )
    .concat(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${AUSTRIAN_HUB_PATH.it}">`)
    .join('\n');

  const breadcrumb = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: c.hubLabel, item: canonicalUrl },
    ],
  });

  const html = buildSeoPageHtml({
    locale,
    title: c.hubTitle,
    description: c.hubLede,
    canonicalUrl,
    robots: 'index,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hubHreflang,
    jsonLdScripts: [breadcrumb],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html };
}

// ── Sitemap ─────────────────────────────────────────────────────

function buildSitemap(dateStamp: string): string {
  const entry = (canonicalPath: string, alts: Array<{ hreflang: string; href: string }>, priority: string) => {
    const altLines = alts
      .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`)
      .join('\n');
    return `  <url>\n    <loc>${BASE_URL}${canonicalPath}</loc>\n${altLines}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  };

  const urls: string[] = [];

  urls.push(
    entry(
      AUSTRIAN_HUB_PATH.it,
      AUSTRIAN_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${AUSTRIAN_HUB_PATH[l]}` })).concat({
        hreflang: 'x-default',
        href: `${BASE_URL}${AUSTRIAN_HUB_PATH.it}`,
      }),
      '0.7',
    ),
  );

  for (const m of AUSTRIAN_ABOVE_FLOOR) {
    urls.push(
      entry(
        austrianMunicipalityPathFor('it', m.slug),
        AUSTRIAN_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${austrianMunicipalityPathFor(l, m.slug)}` })).concat({
          hreflang: 'x-default',
          href: `${BASE_URL}${austrianMunicipalityPathFor('it', m.slug)}`,
        }),
        '0.6',
      ),
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

export function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const sitemapPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;
  let idx = fs.readFileSync(sitemapPath, 'utf-8');
  if (!idx.includes(SITEMAP_NAME)) {
    idx = idx.replace(
      '</sitemapindex>',
      `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_NAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
    );
  } else {
    idx = idx.replace(
      new RegExp(`(<loc>${BASE_URL.replace(/\//g, '\\/')}/${SITEMAP_NAME}<\\/loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(<\\/lastmod>)`),
      `$1${dateStamp}$2`,
    );
  }
  fs.writeFileSync(sitemapPath, idx, 'utf-8');
}

// ── Plugin ──────────────────────────────────────────────────────

export function austrianBorderMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'austrian-border-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_AUSTRIAN_BORDER_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[austrian-border-municipalities]\x1b[0m skipped (SKIP_AUSTRIAN_BORDER_MUNICIPALITY_PAGES=1)');
        resolveAustrianBorderMunicipalitiesFlushed([]);
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveAustrianBorderMunicipalitiesFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'austrianBorderMunicipalityPagesPlugin' });
      const t0 = Date.now();
      let indexablePages = 0;
      let bridgePages = 0;
      let thinPages = 0;

      const hubPaths: string[] = [];
      for (const locale of AUSTRIAN_LOCALES) {
        const { urlPath, html } = renderHubPage({ locale, dateStamp, distDir });
        collector.add(path.join(distDir, urlPath, 'index.html'), html);
        collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
        hubPaths.push(urlPath);
      }

      for (const municipality of AUSTRIAN_ABOVE_FLOOR) {
        for (const locale of AUSTRIAN_LOCALES) {
          const { urlPath, html, wordCount } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir });
          if (wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          indexablePages++;
        }
      }

      for (const municipality of AUSTRIAN_BELOW_FLOOR) {
        for (const locale of AUSTRIAN_LOCALES) {
          const urlPath = austrianMunicipalityPathFor(locale, municipality.slug);
          const html = renderBridgePage({ municipality, locale, distDir });
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          bridgePages++;
        }
      }

      const written = await collector.flush();

      fs.writeFileSync(path.join(distDir, SITEMAP_NAME), buildSitemap(dateStamp), 'utf-8');
      patchSitemapIndex(distDir, dateStamp);

      console.log(
        `\x1b[36m[austrian-border-municipalities]\x1b[0m ${AUSTRIAN_ABOVE_FLOOR.length} above-floor + ${AUSTRIAN_BELOW_FLOOR.length} below-floor → ` +
          `${indexablePages} pages (${thinPages} thin) + ${bridgePages} bridges + ${AUSTRIAN_LOCALES.length} hubs — ` +
          `flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Unblocks austrianBorderMunicipalityLinksPlugin, which injects a hub
      // link into the per-locale HTML sitemap page — without it the whole
      // sitemap-comuni-austria.xml shard ships BFS-unreachable from `/`
      // (same orphan-tier hazard as the sibling families, audit:max-bfs-depth
      // regression #4593).
      resolveAustrianBorderMunicipalitiesFlushed(hubPaths);
    },
  };
}
