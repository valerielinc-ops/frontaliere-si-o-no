/**
 * jobBoardCommuterContext.ts
 *
 * Why this exists
 * ---------------
 * The Apr 2026 audit caught 824 job-board pages at <10 % visible-text/HTML
 * ratio. The root cause is that the city landings, sector×location landings,
 * type×location landings, today editorial pages, and category-listing pages
 * all share the same heavy SPA-style markup (~95-138 KB) wrapping ~4 KB of
 * actual prose. Semrush flags any page below the 10 % threshold.
 *
 * The fix (CLAUDE.md non-negotiable rule "Never accept thin content"):
 * append a substantial commuter-context prose block — methodology, city- /
 * sector- / type-specific frontaliere context, scenario walk-through, and
 * a 4-FAQ block — at the bottom of every heavy template.
 *
 * To avoid template duplication (Google penalty), the prose is parameterised
 * by city / sector / type and uses real commute data from the city table.
 * Pages that share the same city see slight variation by sector/type label
 * interpolation; pages that differ in city see different commute data and
 * different salary brackets. There is NO hidden text — all colour comes from
 * semantic tokens in `index.css` so it works in light + dark mode.
 *
 * Acceptable content kinds (per CLAUDE.md SEO playbook):
 *  - Methodology paragraph (how listings are sourced, refresh cadence)
 *  - Commuter context (city-specific TILO times, salary spread, Permit G)
 *  - FAQ block (3-5 Q&A relevant to the page)
 *  - Scenario walk-through with city-specific numbers
 *  - Cross-references to calculator / FX / health-insurance comparator
 */

import {
  renderCantonSeoProse,
  type CantonSeoSlot,
} from './cantonSeoProse';

export type CommuterLocale = 'it' | 'en' | 'de' | 'fr';

interface CityCommuteRow {
  /** Display name in the IT canonical form. */
  display: string;
  /** Distance in km from the nearest typical Italian feeder city. */
  fromComoKm?: number;
  fromVareseKm?: number;
  /** TILO/auto travel time in minutes (off-peak). */
  driveMinutes?: number;
  trainMinutes?: number;
  /** Indicative gross-annual CHF salary spread for skilled office roles. */
  grossSpreadKChf?: [number, number];
  /** Anchor industries for the city. */
  anchors?: string[];
  /** Italian crossings reachable in <30 min from the city. */
  crossings?: string[];
}

const CITY_COMMUTE: Record<string, CityCommuteRow> = {
  lugano: {
    display: 'Lugano',
    fromComoKm: 28,
    fromVareseKm: 35,
    driveMinutes: 30,
    trainMinutes: 32,
    grossSpreadKChf: [70, 130],
    anchors: ['banche e wealth management', 'sanità EOC', 'università USI', 'fintech', 'farmaceutica'],
    crossings: ['Brogeda', 'Gandria', 'Ponte Tresa'],
  },
  mendrisio: {
    display: 'Mendrisio',
    fromComoKm: 14,
    fromVareseKm: 22,
    driveMinutes: 15,
    trainMinutes: 18,
    grossSpreadKChf: [60, 105],
    anchors: ['orologeria di lusso', 'meccanica di precisione', 'logistica e retail', 'farmaceutica'],
    crossings: ['Chiasso-Brogeda', 'Stabio', 'Gaggiolo'],
  },
  chiasso: {
    display: 'Chiasso',
    fromComoKm: 5,
    fromVareseKm: 28,
    driveMinutes: 8,
    trainMinutes: 10,
    grossSpreadKChf: [55, 95],
    anchors: ['logistica e dogane', 'banche', 'gestione patrimoni', 'retail'],
    crossings: ['Chiasso-Strada', 'Brogeda', 'Pedrinate'],
  },
  bellinzona: {
    display: 'Bellinzona',
    fromComoKm: 60,
    fromVareseKm: 70,
    driveMinutes: 55,
    trainMinutes: 50,
    grossSpreadKChf: [65, 120],
    anchors: ['amministrazione cantonale', 'sanità EOC', 'biotech IRB', 'edilizia e infrastrutture'],
    crossings: ['Brogeda', 'Stabio'],
  },
  locarno: {
    display: 'Locarno',
    fromComoKm: 90,
    fromVareseKm: 75,
    driveMinutes: 75,
    trainMinutes: 90,
    grossSpreadKChf: [60, 110],
    anchors: ['turismo e ospitalità', 'commercio al dettaglio', 'sanità', 'edilizia'],
    crossings: ['Stabio', 'Ponte Tresa', 'Brogeda'],
  },
  stabio: {
    display: 'Stabio',
    fromComoKm: 22,
    fromVareseKm: 8,
    driveMinutes: 10,
    trainMinutes: 14,
    grossSpreadKChf: [60, 105],
    anchors: ['orologeria', 'tessile e moda', 'meccanica', 'logistica'],
    crossings: ['Stabio', 'Gaggiolo', 'Clivio'],
  },
};

function resolveCommuteRow(location: string): CityCommuteRow | null {
  if (!location) return null;
  const key = location.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(CITY_COMMUTE)) {
    if (key.includes(k)) return v;
  }
  return null;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface CommuterCopy {
  /** Heading for the methodology section. */
  methodologyH: string;
  /** Heading for the commuter section. */
  commuterH: string;
  /** Heading for the salary section. */
  salaryH: string;
  /** Heading for the FAQ section. */
  faqH: string;
  /** Heading for the cross-link / next-step section. */
  ctaH: string;
  /** Methodology paragraph (no city). */
  methodology: string;
  /** "Example" / "Esempio" label for scenario callout. */
  exampleLabel: string;
}

const COPY: Record<CommuterLocale, CommuterCopy> = {
  it: {
    methodologyH: 'Come raccogliamo le offerte e cosa garantisce questo elenco',
    commuterH: 'Vivere in Italia e lavorare in Ticino: la geografia del frontalierato',
    salaryH: 'Stipendio lordo CHF: come arrivare al netto reale',
    faqH: 'Domande frequenti dei lettori frontalieri',
    ctaH: 'Strumenti collegati per i frontalieri',
    exampleLabel: 'Esempio',
    methodology:
      'Le offerte di questa pagina arrivano da un crawler proprietario che ogni 6 ore interroga i principali ATS svizzeri (Smartrecruiters, Workday, ATS proprietari come Talentry e ServiceNow), il Job Center cantonale del Ticino, JobUp, JobScout24 e le pagine carriere dei datori di lavoro storici della piazza ticinese. Ogni annuncio passa una deduplicazione su <em>titolo normalizzato + azienda + comune</em> prima della pubblicazione, così la stessa offerta non compare due volte anche se l\'azienda la pubblica su tre portali diversi. La data visualizzata è quella di pubblicazione originale del datore di lavoro, non quella di scansione, così puoi giudicare la freschezza dell\'opportunità. Manteniamo le offerte online per 30 giorni o fino a quando l\'ATS dell\'azienda non le rimuove (verifichiamo HTTP 404 e redirect "posizione chiusa" ogni 12 ore).',
  },
  en: {
    methodologyH: 'How we collect listings and what this page guarantees',
    commuterH: 'Living in Italy and working in Ticino: the cross-border geography',
    salaryH: 'CHF gross salary: how to land at real take-home',
    faqH: 'Frequent questions from cross-border readers',
    ctaH: 'Related tools for cross-border workers',
    exampleLabel: 'Example',
    methodology:
      'Listings on this page come from a proprietary crawler that polls the main Swiss ATS (Smartrecruiters, Workday, proprietary trackers like Talentry and ServiceNow) every 6 hours, plus the cantonal Ticino Job Center, JobUp, JobScout24 and the career pages of long-standing Ticino employers. Every listing passes a deduplication check on <em>normalised title + company + municipality</em> before publication, so the same role does not appear twice even when the employer posts it on three portals. The displayed date is the original publication date — not the crawl timestamp — so you can judge the freshness. We keep listings online for 30 days or until the employer removes them from its ATS (we verify HTTP 404 and "position closed" redirects every 12 hours).',
  },
  de: {
    methodologyH: 'Wie wir Stellen sammeln und was diese Seite garantiert',
    commuterH: 'In Italien wohnen und im Tessin arbeiten: die Grenzgänger-Geografie',
    salaryH: 'CHF-Bruttolohn: so landen Sie beim echten Netto',
    faqH: 'Häufige Fragen unserer Grenzgänger-Leser',
    ctaH: 'Verwandte Tools für Grenzgänger',
    exampleLabel: 'Beispiel',
    methodology:
      'Die Stellen dieser Seite stammen aus einem eigenen Crawler, der alle 6 Stunden die wichtigsten Schweizer ATS (Smartrecruiters, Workday, proprietäre wie Talentry und ServiceNow), das kantonale Tessiner Job Center, JobUp, JobScout24 und die Karriereseiten der etablierten Tessiner Arbeitgeber abfragt. Jeder Eintrag durchläuft eine Deduplizierung über <em>normalisierten Titel + Unternehmen + Gemeinde</em> vor der Veröffentlichung, sodass dieselbe Stelle nicht zweimal erscheint, auch wenn der Arbeitgeber sie auf drei Portalen einstellt. Das angezeigte Datum ist das Original-Veröffentlichungsdatum — nicht der Crawl-Zeitstempel — so erkennen Sie, wie aktuell die Stelle ist. Wir halten Stellen 30 Tage online oder bis der Arbeitgeber sie aus seinem ATS entfernt (HTTP 404 und "Position geschlossen"-Redirects werden alle 12 Stunden geprüft).',
  },
  fr: {
    methodologyH: 'Comment nous collectons les offres et ce que garantit cette page',
    commuterH: 'Vivre en Italie et travailler au Tessin : la géographie du frontalier',
    salaryH: 'Salaire brut CHF : comment arriver au net réel',
    faqH: 'Questions fréquentes de nos lecteurs frontaliers',
    ctaH: 'Outils associés pour frontaliers',
    exampleLabel: 'Exemple',
    methodology:
      'Les offres listées proviennent d\'un crawler propriétaire qui interroge toutes les 6 heures les principaux ATS suisses (Smartrecruiters, Workday, ATS propriétaires comme Talentry et ServiceNow), le Job Center cantonal du Tessin, JobUp, JobScout24 et les pages carrières des employeurs historiques de la place tessinoise. Chaque annonce passe une déduplication sur <em>titre normalisé + entreprise + commune</em> avant publication, ainsi la même offre n\'apparaît pas deux fois même si l\'employeur la publie sur trois portails. La date affichée est la date de publication d\'origine — pas l\'horodatage du crawl — pour juger la fraîcheur. Nous gardons les offres en ligne 30 jours ou jusqu\'à ce que l\'employeur les retire de son ATS (HTTP 404 et redirections "poste fermé" vérifiés toutes les 12 heures).',
  },
};

// Per-locale net-salary calculator landing — single source in the LEAF
// module ./calcHref (re-exported here so host plugins keep their import
// path). It moved out of this file because importing it from
// cantonSeoProse.ts created a circular import (this module imports
// renderCantonSeoProse) that froze `CALC_HREF` to undefined at module init
// and crashed the full build (deploy run 27401576244). See calcHref.ts.
export { CALC_HREF } from './calcHref';
import { CALC_HREF } from './calcHref';
// FX_HREF / HEALTH_HREF come from the shared comparatorHref SSOT (canonical,
// curl-verified-200). Local copies had drifted to a dead orphan scheme (#1997).
import { FX_HREF, HEALTH_HREF } from './comparatorHref';

function buildMethodology(locale: CommuterLocale, nationalScope: boolean): string {
  if (!nationalScope) return COPY[locale].methodology;
  if (locale === 'it') return 'Le offerte di questa pagina arrivano da un crawler proprietario che ogni 6 ore interroga i principali ATS svizzeri (Smartrecruiters, Workday, ATS proprietari come Talentry e ServiceNow), JobUp, JobScout24 e le pagine carriere di datori di lavoro in diversi cantoni. Ogni annuncio passa una deduplicazione su <em>titolo normalizzato + azienda + comune</em> prima della pubblicazione, così la stessa offerta non compare due volte anche se l\'azienda la pubblica su più portali. La data visualizzata è quella di pubblicazione originale del datore di lavoro, non quella di scansione, e gli annunci vengono verificati periodicamente per rimuovere le posizioni chiuse.';
  if (locale === 'en') return 'Listings on this page come from a proprietary crawler that polls the main Swiss ATS (Smartrecruiters, Workday, proprietary trackers such as Talentry and ServiceNow) every 6 hours, plus JobUp, JobScout24 and the career pages of employers across several cantons. Every listing passes a deduplication check on <em>normalised title + company + municipality</em> before publication, so the same role does not appear twice when an employer posts it on multiple portals. The displayed date is the employer\'s original publication date, not the crawl timestamp, and listings are checked periodically to remove closed positions.';
  if (locale === 'de') return 'Die Stellen dieser Seite stammen aus einem eigenen Crawler, der alle 6 Stunden die wichtigsten Schweizer ATS (Smartrecruiters, Workday, proprietäre Systeme wie Talentry und ServiceNow), JobUp, JobScout24 und die Karriereseiten von Arbeitgebern in mehreren Kantonen abfragt. Jeder Eintrag durchläuft vor der Veröffentlichung eine Deduplizierung über <em>normalisierten Titel + Unternehmen + Gemeinde</em>, sodass dieselbe Stelle bei mehreren Portalen nicht doppelt erscheint. Das angezeigte Datum ist das Original-Veröffentlichungsdatum des Arbeitgebers und nicht der Crawl-Zeitstempel; geschlossene Stellen werden regelmässig entfernt.';
  return 'Les offres de cette page proviennent d\'un crawler propriétaire qui interroge toutes les 6 heures les principaux ATS suisses (Smartrecruiters, Workday, systèmes propriétaires comme Talentry et ServiceNow), JobUp, JobScout24 et les pages carrières d\'employeurs de plusieurs cantons. Chaque annonce passe une déduplication sur <em>titre normalisé + entreprise + commune</em> avant publication, afin que la même offre n\'apparaisse pas plusieurs fois lorsqu\'un employeur la diffuse sur plusieurs portails. La date affichée est celle de publication d\'origine, pas l\'horodatage du crawl ; les postes fermés sont retirés lors des contrôles périodiques.';
}

function buildCommuterParagraph(locale: CommuterLocale, location: string, row: CityCommuteRow | null): string {
  const loc = location;
  if (!row) {
    if (locale === 'it') return `Per il frontaliere italiano residente nella zona di frontiera (entro 20 km dalla Svizzera), candidarsi a un ruolo a ${loc} richiede il Permesso G. La domanda parte dal datore svizzero, che presenta la richiesta all\'Ufficio della migrazione del Cantone Ticino dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovata annualmente fino al limite contrattuale. Il rientro al domicilio italiano deve avvenire almeno una volta a settimana per mantenere lo status. Non serve un visto separato; il permesso vale come titolo di soggiorno settimanale.`;
    if (locale === 'en') return `For Italian-resident G-permit candidates inside the 20 km border zone, applying to a role in ${loc} requires the cross-border permit. The application is filed by the Swiss employer at the Ticino cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly up to the contract end. Weekly return to the Italian domicile is required to keep the status; no separate visa is needed.`;
    if (locale === 'de') return `Für italienische Grenzgänger mit Wohnsitz innerhalb der 20-km-Grenzzone erfordert eine Bewerbung in ${loc} die G-Bewilligung. Der Antrag wird vom Schweizer Arbeitgeber beim Migrationsamt des Kantons Tessin nach Vertragsunterzeichnung eingereicht: die Erstausstellung dauert 2-6 Wochen, danach erfolgt die jährliche Verlängerung. Eine wöchentliche Rückkehr zum italienischen Wohnsitz ist Pflicht — kein separates Visum nötig.`;
    return `Pour les frontaliers résidents italiens dans la zone des 20 km, postuler à ${loc} requiert le permis G. La demande est faite par l\'employeur suisse à l\'office cantonal des migrations du Tessin après la signature du contrat : la première délivrance prend 2-6 semaines, puis renouvellement annuel. Retour hebdomadaire au domicile italien obligatoire — pas de visa séparé.`;
  }

  const drive = row.driveMinutes ?? 30;
  const train = row.trainMinutes ?? 35;
  const fromComo = row.fromComoKm ?? 30;
  const fromVarese = row.fromVareseKm ?? 35;
  const crossings = (row.crossings ?? []).slice(0, 3).join(', ');
  const anchorsList = (row.anchors ?? []).slice(0, 3).join(', ');

  if (locale === 'it') {
    return `${loc} dista ${fromComo} km da Como e ${fromVarese} km da Varese, con tempi di percorrenza in auto attorno a ${drive} minuti in fascia di morbida traffico (06:30-07:30 e 16:30-19:00 sono ore di punta) e ${train} minuti in TILO (linea Como-Chiasso-${row.display}). I valichi più rapidi per chi pendola verso ${loc} sono ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: in fascia di punta le code possono superare 25 minuti a Brogeda, mentre Stabio resta più scorrevole dopo le 07:15. Il tessuto produttivo locale è ancorato a ${anchorsList || 'banche, sanità e servizi'}: chi lavora in questi settori a ${loc} si muove dentro un mercato denso, con ricambio frequente di posizioni e CCL settoriali ben strutturati. ${buildOmitCommuteParagraph(locale, 'Ticino')}`;
  }
  if (locale === 'en') {
    return `${loc} is ${fromComo} km from Como and ${fromVarese} km from Varese, with off-peak driving time around ${drive} minutes (peaks 06:30-07:30 and 16:30-19:00) and ${train} minutes by TILO regional train (Como-Chiasso-${row.display} line). The fastest crossings for ${loc}-bound commuters are ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: peak-time queues can exceed 25 minutes at Brogeda, while Stabio flows more smoothly after 07:15. The local economy is anchored in ${anchorsList || 'banking, healthcare and services'}: workers in these sectors find a deep market with frequent role rotation and well-structured collective agreements. ${buildOmitCommuteParagraph(locale, 'Ticino')}`;
  }
  if (locale === 'de') {
    return `${loc} liegt ${fromComo} km von Como und ${fromVarese} km von Varese entfernt, mit Fahrzeiten von rund ${drive} Minuten ausserhalb der Stosszeiten (Spitzen 06:30-07:30 und 16:30-19:00) und ${train} Minuten mit der TILO-Regionalbahn (Linie Como-Chiasso-${row.display}). Die schnellsten Übergänge für Pendler nach ${loc} sind ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: in der Spitze können Wartezeiten an Brogeda 25 Minuten überschreiten, während Stabio nach 07:15 flüssiger fliesst. Die lokale Wirtschaft ruht auf ${anchorsList || 'Banken, Gesundheitswesen und Dienstleistungen'}: in diesen Sektoren finden Beschäftigte einen dichten Markt mit häufiger Rollenrotation und gut strukturierten GAV. ${buildOmitCommuteParagraph(locale, 'Ticino')}`;
  }
  return `${loc} se trouve à ${fromComo} km de Côme et ${fromVarese} km de Varèse, avec un temps de trajet en voiture d\'environ ${drive} minutes hors pointe (pointes 06:30-07:30 et 16:30-19:00) et ${train} minutes en train régional TILO (ligne Côme-Chiasso-${row.display}). Les passages les plus rapides pour les frontaliers vers ${loc} sont ${crossings || 'Brogeda, Stabio, Ponte Tresa'} : aux heures de pointe, les files à Brogeda peuvent dépasser 25 minutes, tandis que Stabio est plus fluide après 07:15. L\'économie locale s\'appuie sur ${anchorsList || 'banques, santé et services'} : dans ces secteurs, les travailleurs trouvent un marché dense avec rotation fréquente et conventions collectives bien structurées. ${buildOmitCommuteParagraph(locale, 'Ticino')}`;
}

/** Canton-wide listing context: permit rules and tax status are distinct. */
function buildOmitCommuteParagraph(locale: CommuterLocale, location: string): string {
  const isTicino = /^(ticino|tessin)$/i.test(location.trim());
  const country = { it: 'Svizzera', en: 'Switzerland', de: 'Schweiz', fr: 'Suisse' };
  const scope = escAttr(CH_REGION_NAMES.has(location.trim()) ? country[locale] : isTicino && locale === 'de' ? 'Tessin' : location.trim());
  const source = '<a href="https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/">SPOP Ticino</a>';
  if (locale === 'it') return `Le offerte riguardano ${scope}. Il permesso G consente di lavorare sul territorio svizzero mantenendo la residenza principale all’estero e rientrando almeno settimanalmente. La fascia dei 20 km è un requisito fiscale dell’accordo, non una condizione generale del permesso G UE/AELS. ${isTicino ? 'In Ticino rilascio e rinnovo per cittadini UE/AELS maggiorenni costano CHF 75; altre categorie e pratiche hanno tariffe diverse.' : 'Costi, procedura e scadenza dipendono dal cantone e dalla categoria del richiedente; il permesso non è generalmente gratuito.'} Presenta la domanda prima di iniziare l’attività e verifica la scadenza riportata sul permesso. Fonte per il Ticino: ${source}.`;
  if (locale === 'en') return `These listings concern ${scope}. A G permit covers work in Switzerland while keeping a main residence abroad and returning at least weekly. The 20 km border zone is a treaty tax condition, not a general EU/EFTA G-permit requirement. ${isTicino ? 'In Ticino, issuance and renewal for adult EU/EFTA nationals cost CHF 75; other categories and procedures have different fees.' : 'Fees, procedures and expiry depend on the canton and applicant category; the permit is not generally free.'} Apply before starting work and check the expiry shown on the permit. Source for Ticino: ${source}.`;
  if (locale === 'de') return `Die Angebote betreffen ${scope}. Die G-Bewilligung ermöglicht Arbeit in der Schweiz bei Hauptwohnsitz im Ausland und mindestens wöchentlicher Rückkehr. Die 20-km-Grenzzone ist eine steuerliche Abkommensbedingung, keine allgemeine Voraussetzung der G-Bewilligung EU/EFTA. ${isTicino ? 'Im Tessin kosten Erteilung und Verlängerung für volljährige EU/EFTA-Angehörige CHF 75; andere Kategorien und Verfahren haben andere Gebühren.' : 'Gebühren, Verfahren und Ablauf hängen vom Kanton und der Kategorie ab; die Bewilligung ist nicht generell kostenlos.'} Stellen Sie den Antrag vor Arbeitsbeginn und beachten Sie das Ablaufdatum. Quelle für das Tessin: ${source}.`;
  return `Les offres concernent ${scope}. Le permis G permet de travailler en Suisse avec résidence principale à l’étranger et retour au moins hebdomadaire. La zone de 20 km est une condition fiscale de l’accord, non une condition générale du permis G UE/AELE. ${isTicino ? 'Au Tessin, délivrance et renouvellement pour majeurs UE/AELE coûtent CHF 75; les autres catégories et démarches ont des tarifs différents.' : 'Les frais, démarches et échéances dépendent du canton et de la catégorie; le permis n’est pas généralement gratuit.'} Déposez la demande avant de commencer l’activité et vérifiez l’échéance du permis. Source pour le Tessin: ${source}.`;
}

function buildSalaryParagraph(locale: CommuterLocale): string {
  const source = 'https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf';
  const copy: Record<CommuterLocale, string> = {
    it: 'Quando un annuncio indica una retribuzione, verifica importo lordo, periodo, percentuale di impiego e numero di mensilità. Il netto dipende dalle tariffe cantonali, dai contributi previdenziali e dalla situazione personale. Per i nuovi frontalieri che soddisfano le condizioni dell’accordo Italia-Svizzera, la Svizzera applica l’80% dell’imposta alla fonte ordinaria; questa percentuale non è un limite al credito d’imposta italiano. La sola data di assunzione non determina il regime: contano anche residenza, luogo di lavoro e rientro quotidiano in linea di principio. Il regime transitorio richiede di verificare l’attività frontaliera qualificata tra il 31 dicembre 2018 e il 17 luglio 2023. Fuori dalle condizioni dell’accordo occorre verificare il trattamento applicabile. Inserisci i dati dell’offerta nel calcolatore per una stima e valuta separatamente i costi effettivi del tragitto. Fonte ufficiale:',
    en: 'When a listing states pay, check the gross amount, pay period, workload and number of salary payments. Take-home pay depends on cantonal rates, pension contributions and personal circumstances. For new cross-border workers meeting the Italy–Switzerland agreement conditions, Switzerland applies 80% of ordinary withholding tax; this percentage is not a cap on the Italian tax credit. The hiring date alone does not determine the regime: residence, workplace and daily return in principle also matter. The transitional regime requires checking qualifying frontier work between 31 December 2018 and 17 July 2023. Outside the agreement conditions, the applicable treatment must be checked separately. Enter the offer details in the calculator for an estimate and assess actual commuting costs separately. Official source:',
    de: 'Wenn ein Inserat einen Lohn nennt, prüfen Sie Bruttobetrag, Bezugszeitraum, Arbeitspensum und Anzahl der Monatslöhne. Das Netto hängt von kantonalen Tarifen, Vorsorgebeiträgen und persönlichen Umständen ab. Für neue Grenzgänger, die die Bedingungen des Abkommens Italien–Schweiz erfüllen, erhebt die Schweiz 80% der ordentlichen Quellensteuer; dieser Prozentsatz begrenzt nicht die italienische Steueranrechnung. Das Anstellungsdatum allein bestimmt das Regime nicht: Wohnsitz, Arbeitsort und grundsätzlich tägliche Rückkehr sind ebenfalls relevant. Für die Übergangsregelung ist eine qualifizierte Grenzgängertätigkeit zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 zu prüfen. Ausserhalb der Abkommensbedingungen ist die anwendbare Behandlung gesondert zu prüfen. Geben Sie die Angebotsdaten für eine Schätzung im Rechner ein und berücksichtigen Sie die tatsächlichen Pendelkosten separat. Offizielle Quelle:',
    fr: 'Lorsqu’une offre indique un salaire, vérifiez le montant brut, la période, le taux d’activité et le nombre de mensualités. Le net dépend des barèmes cantonaux, des cotisations de prévoyance et de la situation personnelle. Pour les nouveaux frontaliers remplissant les conditions de l’accord Italie–Suisse, la Suisse applique 80% de l’impôt à la source ordinaire ; ce pourcentage ne plafonne pas le crédit d’impôt italien. La date d’embauche seule ne détermine pas le régime : résidence, lieu de travail et retour quotidien en principe comptent aussi. Le régime transitoire exige de vérifier une activité frontalière qualifiée entre le 31 décembre 2018 et le 17 juillet 2023. Hors des conditions de l’accord, le traitement applicable doit être vérifié séparément. Saisissez les données de l’offre dans le calculateur pour une estimation et évaluez séparément les frais réels du trajet. Source officielle:',
  };
  return `${escAttr(copy[locale])} <a href="${source}">ESTV / AFC</a>`;
}

function buildScenarioCallout(locale: CommuterLocale, location: string, row: CityCommuteRow | null, nationalScope = false): string {
  const grossK = row?.grossSpreadKChf ? Math.round((row.grossSpreadKChf[0] + row.grossSpreadKChf[1]) / 2) : 80;
  const grossMonthly = Math.round((grossK * 1000) / 13);
  const sourceTaxPct = 13;
  const sourceTax = Math.round((grossMonthly * sourceTaxPct) / 100);
  const avs = Math.round(grossMonthly * 0.053);
  const lpp = Math.round(grossMonthly * 0.07);
  const netCh = grossMonthly - sourceTax - avs - lpp;
  const netEur = Math.round(netCh * 0.97);

  const example = COPY[locale].exampleLabel;
  if (nationalScope) {
    if (locale === 'it') {
      return `<strong>${example}</strong>: un candidato con un\'offerta in Svizzera di CHF ${grossMonthly.toLocaleString('it-CH')} lordi mensili (CHF ${grossK}\'000 lordi annui su 13 mensilità). In questa simulazione l\'imposta alla fonte è ipotizzata al ${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('it-CH')}), con AVS-AI-IPG 5,3 % (~CHF ${avs.toLocaleString('it-CH')}) e LPP ~7 % (~CHF ${lpp.toLocaleString('it-CH')}). Netto svizzero indicativo ~CHF ${netCh.toLocaleString('it-CH')}/mese, pari a ~EUR ${netEur.toLocaleString('it-CH')} con cambio 0,97. L\'aliquota effettiva e il calcolo italiano cambiano in base al cantone, al regime fiscale e ai dati personali: il calcolatore Frontaliere Ticino confronta questi scenari e mostra il netto stimato.`;
    }
    if (locale === 'en') {
      return `<strong>${example}</strong>: a candidate with a CHF ${grossMonthly.toLocaleString('en-CH')} gross monthly offer in Switzerland (CHF ${grossK},000 gross/year over 13 months). This illustration assumes ${sourceTaxPct} % withholding tax (~CHF ${sourceTax.toLocaleString('en-CH')}), AVS-AI-IPG at 5.3 % (~CHF ${avs.toLocaleString('en-CH')}) and LPP at about 7 % (~CHF ${lpp.toLocaleString('en-CH')}). Indicative Swiss net: ~CHF ${netCh.toLocaleString('en-CH')}/month, or ~EUR ${netEur.toLocaleString('en-CH')} at 0.97. The effective rate and Italian calculation change with canton, tax regime and personal details; the Frontaliere Ticino calculator compares these scenarios and estimates take-home.`;
    }
    if (locale === 'de') {
      return `<strong>${example}</strong>: eine Person mit einem Bruttoangebot von CHF ${grossMonthly.toLocaleString('de-CH')} pro Monat in der Schweiz (CHF ${grossK}\'000 Brutto/Jahr auf 13 Monatslöhnen). Diese Veranschaulichung nimmt ${sourceTaxPct} % Quellensteuer (~CHF ${sourceTax.toLocaleString('de-CH')}), AHV-IV-EO 5,3 % (~CHF ${avs.toLocaleString('de-CH')}) und BVG rund 7 % (~CHF ${lpp.toLocaleString('de-CH')}) an. Indikatives Schweizer Netto: ~CHF ${netCh.toLocaleString('de-CH')} pro Monat bzw. ~EUR ${netEur.toLocaleString('de-CH')} bei einem Kurs von 0,97. Der effektive Satz und die italienische Berechnung ändern sich je nach Kanton, Steuerregime und persönlichen Daten; der Frontaliere-Ticino-Rechner vergleicht diese Szenarien.`;
    }
    return `<strong>${example}</strong> : une personne avec une offre brute de CHF ${grossMonthly.toLocaleString('fr-CH')} par mois en Suisse (CHF ${grossK} 000 brut/an sur 13 mois). Cette illustration suppose ${sourceTaxPct} % d\'impôt à la source (~CHF ${sourceTax.toLocaleString('fr-CH')}), AVS-AI-APG 5,3 % (~CHF ${avs.toLocaleString('fr-CH')}) et LPP ~7 % (~CHF ${lpp.toLocaleString('fr-CH')}). Net suisse indicatif : ~CHF ${netCh.toLocaleString('fr-CH')}/mois, soit ~EUR ${netEur.toLocaleString('fr-CH')} au taux de 0,97. Le taux effectif et le calcul italien varient selon le canton, le régime fiscal et les données personnelles ; le calculateur Frontaliere Ticino compare ces scénarios.`;
  }
  if (locale === 'it') {
    return `<strong>${example}</strong>: un quadro con offerta CHF ${grossMonthly.toLocaleString('it-CH')} lordi mensili a ${location} (CHF ${grossK}\'000 lordi annui su 13 mensilità). Imposta alla fonte ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('it-CH')}), AVS-AI-IPG 5,3 % (~CHF ${avs.toLocaleString('it-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('it-CH')}). Netto svizzero ~CHF ${netCh.toLocaleString('it-CH')}/mese. Cambio EUR a 0,97 → ~EUR ${netEur.toLocaleString('it-CH')}. La compensazione fiscale tra Stati non è un rimborso al lavoratore; l’eventuale imposta italiana dipende dal regime applicabile. Il calcolatore Frontaliere Ticino integra entrambi i regimi (vecchio e nuovo accordo) e mostra il netto effettivo.`;
  }
  if (locale === 'en') {
    return `<strong>${example}</strong>: a manager with a CHF ${grossMonthly.toLocaleString('en-CH')} gross monthly offer in ${location} (CHF ${grossK},000 gross/year over 13 months). Source tax ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('en-CH')}), AVS-AI-IPG 5.3 % (~CHF ${avs.toLocaleString('en-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('en-CH')}). Swiss net ~CHF ${netCh.toLocaleString('en-CH')}/month. EUR rate at 0.97 → ~EUR ${netEur.toLocaleString('en-CH')}. The fiscal compensation between states is not a worker refund; any Italian tax depends on the applicable regime. The Frontaliere Ticino calculator handles both regimes (old + new agreement) and shows the effective net.`;
  }
  if (locale === 'de') {
    return `<strong>${example}</strong>: eine Kaderstelle mit Bruttoangebot CHF ${grossMonthly.toLocaleString('de-CH')} pro Monat in ${location} (CHF ${grossK}\'000 Brutto/Jahr auf 13 Monatslöhnen). Quellensteuer ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('de-CH')}), AHV-IV-EO 5,3 % (~CHF ${avs.toLocaleString('de-CH')}), BVG ~7 % (~CHF ${lpp.toLocaleString('de-CH')}). Schweizer Netto ~CHF ${netCh.toLocaleString('de-CH')}/Monat. EUR-Kurs 0,97 → ~EUR ${netEur.toLocaleString('de-CH')}. Der staatliche Finanzausgleich ist keine Erstattung an Arbeitnehmer; eine italienische Steuer hängt vom geltenden Regime ab. Der Frontaliere-Ticino-Rechner deckt beide Regime ab (altes + neues Abkommen).`;
  }
  return `<strong>${example}</strong> : un cadre avec offre brute CHF ${grossMonthly.toLocaleString('fr-CH')} par mois à ${location} (CHF ${grossK} 000 brut/an sur 13 mois). Impôt à la source ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('fr-CH')}), AVS-AI-APG 5,3 % (~CHF ${avs.toLocaleString('fr-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('fr-CH')}). Net suisse ~CHF ${netCh.toLocaleString('fr-CH')}/mois. Taux EUR à 0,97 → ~EUR ${netEur.toLocaleString('fr-CH')}. La compensation fiscale entre États n’est pas un remboursement au travailleur; l’impôt italien éventuel dépend du régime applicable. Le calculateur Frontaliere Ticino couvre les deux régimes (ancien + nouvel accord).`;
}

// Region-scoped `location` values (whole canton / all of Switzerland).
// Canton-scoped callers either pass `cantonDisplay === location` or one of
// these literals; city pages always pass a municipality name. Used to pick
// the correct locative preposition in the FAQ ("in Ticino", not "a Ticino").
const CH_REGION_NAMES = new Set(['Svizzera', 'Switzerland', 'Schweiz', 'Suisse']);
const TI_REGION_NAMES = new Set(['Ticino', 'Tessin']);

function isSwitzerlandLocation(location: string): boolean {
  return CH_REGION_NAMES.has(location.trim());
}

function isRegionLocation(location: string, cantonDisplay?: string | null): boolean {
  const loc = (location || '').trim();
  if (!loc) return false;
  if (CH_REGION_NAMES.has(loc) || TI_REGION_NAMES.has(loc)) return true;
  return !!cantonDisplay && cantonDisplay.trim() === loc;
}

function buildFaq(locale: CommuterLocale, location: string, sectorOrType: string | null, regionScope: boolean, nationalScope = false): Array<{ q: string; a: string }> {
  const safeSector = sectorOrType || (locale === 'it' ? 'questo settore' : locale === 'en' ? 'this sector' : locale === 'de' ? 'diesem Sektor' : 'ce secteur');
  if (locale === 'it') {
    return [
      {
        q: `Quanti giorni a settimana posso lavorare da remoto restando frontaliere?`,
        a: `Per i frontalieri fiscali Italia–Svizzera, fino al 25% del tempo di lavoro da casa mantiene il trattamento fiscale previsto dall’accordo. La previdenza segue regole distinte: tra il 25% e il 49,9% la copertura svizzera può continuare se si applica la deroga multilaterale e il datore richiede il certificato A1. Concorda quota e adempimenti con HR. <a href="https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0">Regole fiscali</a>; <a href="https://www.bsv.admin.ch/it/telelavoro">assicurazioni sociali</a>.`,
      },
      {
        q: nationalScope ? 'La zona di frontiera è uguale in tutta la Svizzera?' : `Per ${location} esiste una zona di frontiera diversa rispetto al resto della Svizzera?`,
        a: nationalScope
          ? `No: il regime della zona di frontiera non si applica in modo identico a tutti i cantoni. Per le posizioni in Ticino, il Nuovo Accordo Italia-Svizzera 2024 riguarda i comuni italiani entro 20 km dal confine svizzero; per gli altri cantoni vanno verificate le regole fiscali e contributive del rapporto specifico. Chiedi al datore di lavoro quale regime si applica prima di firmare.`
          : `No: la "zona di frontiera" del Nuovo Accordo Italia-Svizzera 2024 è la stessa per tutto il Cantone Ticino — i comuni italiani entro 20 km dal confine svizzero. Quello che cambia da Lugano a Bellinzona è il tempo di percorrenza, non il regime fiscale. La residenza italiana resta nello stesso comune anche se cambi azienda da una città ticinese all\'altra.`,
      },
      {
        q: `I titoli di studio italiani sono riconosciuti ${sectorOrType ? `nel settore ${sectorOrType}` : `per ${safeSector}`} ${nationalScope ? 'in Svizzera' : `${regionScope ? 'in' : 'a'} ${location}`}?`,
        a: `Per le professioni non regolamentate il riconoscimento formale non è un requisito per candidarsi. Per le professioni regolamentate verifica l’autorità competente: non tutte le pratiche fanno capo alla SEFRI. Cerca il titolo professionale su <a href="https://www.recognition.swiss/en">recognition.swiss</a> e segui le indicazioni per documenti e procedura. I tempi dipendono dalla pratica completa e dall’autorità; non esiste una durata garantita comune a tutte le professioni.`,
      },
      {
        q: `Quanto incide davvero il pendolarismo sul reddito mensile?`,
        a: `Calcola i chilometri effettivi di andata e ritorno e i giorni di presenza al mese. Per l’auto considera consumo, prezzo del carburante, parcheggio, pedaggi, manutenzione e quota dei costi fissi. Per il treno verifica il prezzo dell’abbonamento sul percorso e gli eventuali trasferimenti. Confronta le alternative usando gli stessi giorni di lavoro, includendo tempo di viaggio e compatibilità con i turni. Il costo del tragitto riduce il budget disponibile; una deduzione fiscale non è automatica.`,
      },
    ];
  }
  if (locale === 'en') {
    return [
      {
        q: `How many days a week can I work remotely while keeping cross-border status?`,
        a: `For Italy–Switzerland tax frontier workers, home working up to 25% of working time preserves the agreement’s tax treatment. Social insurance has separate rules: between 25% and 49.9%, Swiss coverage may continue under the multilateral exemption if its conditions are met and the employer requests an A1 certificate. Agree the share and formalities with HR. <a href="https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0">Tax rules</a>; <a href="https://www.bsv.admin.ch/it/telelavoro">social insurance</a>.`,
      },
      {
        q: nationalScope ? 'Is the border zone the same across Switzerland?' : `Does ${location} have a different border zone than the rest of Switzerland?`,
        a: nationalScope
          ? `No: the border-zone regime does not apply identically in every canton. For roles in Ticino, the 2024 Italy-Switzerland agreement concerns Italian municipalities within 20 km of the Swiss border; for other cantons, verify the tax and social-security rules for the specific employment. Ask the employer which regime applies before signing.`
          : `No: the "border zone" of the 2024 Italy-Switzerland agreement is the same across the Canton of Ticino — Italian municipalities within 20 km of the Swiss border. What changes between Lugano and Bellinzona is the commute time, not the tax regime. Your Italian residence stays in the same municipality even if you switch employers between Ticino cities.`,
      },
      {
        q: `Are Italian qualifications recognised for ${safeSector} in ${location}?`,
        a: `For non-regulated professions, formal recognition is not a prerequisite for applying. For regulated professions, identify the competent body: SERI does not handle every application. Search for the occupation on <a href="https://www.recognition.swiss/en">recognition.swiss</a> and follow the document and procedure requirements. Processing time depends on the complete application and responsible body; there is no guaranteed duration shared by every profession.`,
      },
      {
        q: `How much does the commute actually cost on a monthly basis?`,
        a: `Calculate the actual return distance and monthly days on site. For a car, include fuel consumption and price, parking, tolls, maintenance and a share of fixed costs. For rail, check the pass price for the route and any connecting journeys. Compare options using the same working days, including travel time and compatibility with shifts. Commuting costs reduce your available budget; a tax deduction is not automatic.`,
      },
    ];
  }
  if (locale === 'de') {
    return [
      {
        q: `Wie viele Tage pro Woche kann ich als Grenzgänger im Homeoffice arbeiten?`,
        a: `Für steuerliche Grenzgänger zwischen Italien und der Schweiz bleibt die Besteuerung nach dem Abkommen bei bis zu 25% Homeoffice erhalten. Für Sozialversicherungen gelten andere Regeln: Bei 25% bis 49,9% kann die Schweizer Versicherung unter den Voraussetzungen der multilateralen Ausnahme weitergelten; der Arbeitgeber muss eine A1-Bescheinigung beantragen. Anteil und Formalitäten mit HR klären. <a href="https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0">Steuerregeln</a>; <a href="https://www.bsv.admin.ch/it/telelavoro">Sozialversicherungen</a>.`,
      },
      {
        q: nationalScope ? 'Gilt die Grenzzone in der ganzen Schweiz gleich?' : `Hat ${location} eine andere Grenzzone als der Rest der Schweiz?`,
        a: nationalScope
          ? `Nein: das Grenzzonen-Regime gilt nicht in jedem Kanton gleich. Für Stellen im Tessin betrifft das Steuerabkommen 2024 italienische Gemeinden innerhalb von 20 km zur Schweizer Grenze; für andere Kantone müssen die Steuer- und Sozialversicherungsregeln des konkreten Arbeitsverhältnisses geprüft werden. Klären Sie vor Vertragsabschluss mit dem Arbeitgeber, welches Regime gilt.`
          : `Nein: die "Grenzzone" des Steuerabkommens 2024 ist im gesamten Kanton Tessin identisch — italienische Gemeinden innerhalb von 20 km zur Schweizer Grenze. Was sich zwischen Lugano und Bellinzona unterscheidet, ist die Pendelzeit, nicht das Steuerregime. Der italienische Wohnsitz bleibt in derselben Gemeinde, auch wenn Sie den Arbeitgeber zwischen Tessiner Städten wechseln.`,
      },
      {
        q: `Werden italienische Qualifikationen für ${safeSector} ${nationalScope ? 'in der Schweiz' : `in ${location}`} anerkannt?`,
        a: `Für nicht reglementierte Berufe ist eine formelle Anerkennung keine Voraussetzung für eine Bewerbung. Bei reglementierten Berufen ist die zuständige Stelle zu prüfen: Nicht alle Gesuche bearbeitet das SBFI. Suchen Sie den Beruf auf <a href="https://www.recognition.swiss/en">recognition.swiss</a> und beachten Sie die Vorgaben zu Unterlagen und Verfahren. Die Bearbeitungszeit hängt vom vollständigen Gesuch und der zuständigen Stelle ab; eine einheitliche garantierte Frist gibt es nicht.`,
      },
      {
        q: `Wie stark belastet das Pendeln das monatliche Einkommen tatsächlich?`,
        a: `Berechnen Sie die tatsächliche Hin- und Rückfahrstrecke und die monatlichen Präsenztage. Beim Auto zählen Verbrauch, Treibstoffpreis, Parken, Maut, Wartung und anteilige Fixkosten. Bei der Bahn prüfen Sie den Abonnementpreis für die Strecke und mögliche Anschlussfahrten. Vergleichen Sie die Optionen anhand derselben Arbeitstage und berücksichtigen Sie Reisezeit und Schichten. Pendelkosten mindern das verfügbare Budget; ein Steuerabzug ist nicht automatisch gegeben.`,
      },
    ];
  }
  return [
    {
      q: `Combien de jours par semaine puis-je télétravailler en gardant le statut de frontalier ?`,
      a: `Pour les frontaliers fiscaux Italie–Suisse, le télétravail à domicile jusqu’à 25% du temps de travail préserve le traitement fiscal de l’accord. Les assurances sociales suivent des règles distinctes : entre 25% et 49,9%, la couverture suisse peut continuer si les conditions de la dérogation multilatérale sont remplies et si l’employeur demande une attestation A1. Convenir de la part et des formalités avec les RH. <a href="https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0">Règles fiscales</a>; <a href="https://www.bsv.admin.ch/it/telelavoro">assurances sociales</a>.`,
    },
    {
      q: nationalScope ? 'La zone frontalière est-elle identique dans toute la Suisse ?' : `${location} a-t-il une zone frontalière différente du reste de la Suisse ?`,
      a: nationalScope
        ? `Non : le régime de la zone frontalière ne s\'applique pas de la même façon dans tous les cantons. Pour les postes au Tessin, l\'accord fiscal 2024 concerne les communes italiennes dans les 20 km de la frontière suisse ; pour les autres cantons, il faut vérifier les règles fiscales et sociales de l\'emploi concerné. Demandez à l\'employeur quel régime s\'applique avant de signer.`
        : `Non : la "zone frontalière" de l\'accord 2024 est identique dans tout le canton du Tessin — les communes italiennes dans les 20 km de la frontière suisse. Ce qui change entre Lugano et Bellinzone est le temps de trajet, pas le régime fiscal. Votre résidence italienne reste dans la même commune même si vous changez d\'employeur entre les villes tessinoises.`,
    },
    {
      q: `Les qualifications italiennes sont-elles reconnues ${sectorOrType ? `pour le secteur ${sectorOrType}` : `pour ${safeSector}`} ${regionScope ? (CH_REGION_NAMES.has(location.trim()) ? `en ${location}` : `dans le canton de ${location}`) : `à ${location}`} ?`,
      a: `Pour les professions non réglementées, la reconnaissance formelle n’est pas un préalable à une candidature. Pour les professions réglementées, identifiez l’organisme compétent : le SEFRI ne traite pas toutes les demandes. Recherchez la profession sur <a href="https://www.recognition.swiss/en">recognition.swiss</a> et suivez les exigences documentaires et procédurales. Les délais dépendent du dossier complet et de l’organisme ; aucune durée garantie ne vaut pour toutes les professions.`,
    },
    {
      q: `Combien coûte vraiment le trajet sur une base mensuelle ?`,
      a: `Calculez la distance réelle aller-retour et les jours de présence mensuels. Pour la voiture, comptez consommation, prix du carburant, stationnement, péages, entretien et part des frais fixes. Pour le train, vérifiez le prix de l’abonnement du parcours et des correspondances. Comparez les options sur les mêmes jours de travail, en tenant compte du temps de trajet et des horaires. Le trajet réduit votre budget disponible ; une déduction fiscale n’est pas automatique.`,
    },
  ];
}

function buildCrossLinks(locale: CommuterLocale, nationalScope = false): string {
  const calc = `<a class="s-U9K6Vf" href="${CALC_HREF[locale]}">`;
  const fx = `<a class="s-U9K6Vf" href="${FX_HREF[locale]}">`;
  const health = `<a class="s-U9K6Vf" href="${HEALTH_HREF[locale]}">`;
  if (locale === 'it') {
    return `Tre strumenti gratuiti per chiudere il cerchio prima di candidarti: ${calc}calcolatore stipendio netto frontaliere</a> con i due regimi fiscali (vecchio + nuovo accordo 2024); ${fx}comparatore cambio CHF/EUR</a> con i tassi di banche italiane, cambia-valute svizzeri e Wise/Revolut; ${health}comparatore casse malati LAMal</a> per scegliere il premio mensile più conveniente ${nationalScope ? 'nel tuo cantone di lavoro' : 'nel tuo comune ticinese di lavoro'}.`;
  }
  if (locale === 'en') {
    return `Three free tools to close the loop before applying: ${calc}cross-border net salary calculator</a> with both tax regimes (old + 2024 new agreement); ${fx}CHF/EUR exchange comparator</a> with rates from Italian banks, Swiss bureaus de change and Wise/Revolut; ${health}LAMal health-insurance comparator</a> to pick the cheapest premium in your ${nationalScope ? 'work canton' : 'Ticino work municipality'}.`;
  }
  if (locale === 'de') {
    return `Drei kostenlose Tools zum Abschluss vor der Bewerbung: ${calc}Netto-Grenzgänger-Lohnrechner</a> mit beiden Steuerregimen (altes + neues Abkommen 2024); ${fx}CHF/EUR-Wechselkurs-Vergleich</a> mit den Kursen italienischer Banken, Schweizer Wechselstuben und Wise/Revolut; ${health}LAMal-Krankenkassen-Vergleich</a> zur Wahl der günstigsten Monatsprämie in Ihrem ${nationalScope ? 'Arbeitskanton' : 'Tessiner Arbeitsgemeinde'}.`;
  }
  return `Trois outils gratuits pour boucler la boucle avant de postuler : ${calc}calculateur de salaire net frontalier</a> avec les deux régimes fiscaux (ancien + nouvel accord 2024) ; ${fx}comparateur de change CHF/EUR</a> avec les taux des banques italiennes, bureaux de change suisses et Wise/Revolut ; ${health}comparateur des caisses maladie LAMal</a> pour choisir la prime mensuelle la plus avantageuse dans votre ${nationalScope ? 'canton de travail' : 'commune tessinoise de travail'}.`;
}

export interface JobBoardCommuterContextOpts {
  locale: CommuterLocale;
  /** City name in display form (e.g. "Lugano"). Used for commute paragraph + scenario. */
  location: string;
  /** Optional sector / contract-type label (e.g. "sanità", "part-time"). */
  sectorOrType?: string | null;
  /** When true, omits the commute table (used for non-city pages like "today"). */
  omitCommute?: boolean;
  /**
   * Optional canton display name (e.g. 'Zurigo', 'Vallese', 'Argovia'). When
   * provided AND the canton is NOT Ticino, the helper appends a second
   * canton-aware prose block via `renderCantonSeoProse`, lifting the visible
   * text by ~5 KB on the heavy non-TI editorial host pages (find-jobs-{canton}/
   * today, /nurses, /clinics, /part-time) that otherwise tripped Semrush's
   * 10 % text-to-HTML threshold. For TI the legacy commuter block is enough
   * and adding the canton block would shift TI HTML — non-TI only.
   */
  cantonDisplay?: string | null;
  /**
   * Editorial slot label, used to pick the right canton-prose flavour. Only
   * read when `cantonDisplay` is set. Defaults to `'canton-hub'` for safety.
   */
  cantonSlot?: CantonSeoSlot | null;
  /**
   * Optional entity name (city display for `city-landing`, company name for
   * `company-landing`). When set, the canton prose helper substitutes the
   * entity into its intro + FAQ wording, making per-page strings unique and
   * avoiding cross-page boilerplate duplication. Only read when
   * `cantonDisplay` is set AND `cantonSlot` is an entity-aware slot.
   */
  cantonEntityName?: string | null;
}

// Memo cache for the appended canton-prose block. Each non-TI editorial page
// re-emits the same (canton × locale × slot × entity) combination identically,
// so caching avoids ~400 redundant string builds across the build. Key fields
// are the only inputs that drive the helper output.
const cantonProseCache = new Map<string, string>();

function getCantonProseBlock(
  locale: CommuterLocale,
  cantonDisplay: string,
  slot: CantonSeoSlot,
  entityName: string | null,
): string {
  const entityKey = entityName ? entityName.trim() : '';
  const key = `${locale}::${cantonDisplay}::${slot}::${entityKey}`;
  const cached = cantonProseCache.get(key);
  if (cached !== undefined) return cached;
  const html = renderCantonSeoProse({
    locale,
    cantonDisplay,
    slot,
    entityName: entityKey || null,
    countHint: null,
    ctaHref: null,
    ctaLabel: null,
  });
  cantonProseCache.set(key, html);
  return html;
}

/**
 * Render a substantial (5-7 KB) page-relevant prose section with:
 *  - methodology paragraph
 *  - commuter / city-context paragraph (city-specific TILO + crossing data)
 *  - salary breakdown paragraph (TI source-tax, AVS, LPP, new agreement)
 *  - scenario callout (numerical example tied to the city)
 *  - 4-FAQ block (telework, border zone, qualification recognition, commute cost)
 *  - cross-link CTA paragraph (calculator, FX, health insurance)
 *
 * The function is pure; given the same locale + location + sector, it returns
 * the same HTML. It uses semantic colour tokens from index.css so the prose
 * works in light + dark mode without `dark:` class prefixes (CLAUDE.md rule).
 */
// Memo cache keyed by the full opts tuple. The output is a deterministic
// function of opts (no module-level mutable state, no Date.now() calls),
// so caching the full HTML is safe.
//
// Cardinality grew after the May 9 baseline (memory:
// project_cluster_render_optimization_may9 → ~560 unique outputs) because
// `cantonEntityName` was added for company-landing rows: it carries
// "${companyName} — ${cityDisplay}" → ~500 companies × ~50 cities × 4
// locales ≈ 100k upper-bound combinations. Realistic build hits ~20-30k
// distinct keys (most company × city pairs don't exist).
//
// maxSize = 30000 keeps the cap as a fail-loud guardrail (a per-slug
// parameter still surfaces as a build error, not a silent leak) but gives
// headroom for the legitimate company × city × locale fan-out. At ~1-2 KB
// per cached HTML the peak heap cost is ~30-60 MB — fine for the 7 GB
// CI heap. If this cap is hit again, the next steps are: (a) split into
// two caches (low-cardinality opts vs. company-landing opts), or (b)
// strip cantonEntityName from the key and re-render the entity-name line
// per call (cheap — single string concat).
const COMMUTER_CONTEXT_CACHE = new Map<string, string>();
const COMMUTER_CONTEXT_CACHE_MAX = 30000;

function commuterContextCacheKey(opts: JobBoardCommuterContextOpts): string {
  // Stable concatenation in field order — cheaper than JSON.stringify on a
  // hot path that runs ~52k times per build. Null/undefined → empty string.
  return (
    opts.locale + '\x00' +
    opts.location + '\x00' +
    (opts.sectorOrType ?? '') + '\x00' +
    (opts.omitCommute ? '1' : '0') + '\x00' +
    (opts.cantonDisplay ?? '') + '\x00' +
    (opts.cantonSlot ?? '') + '\x00' +
    (opts.cantonEntityName ?? '')
  );
}

export function renderJobBoardCommuterContext(
  opts: JobBoardCommuterContextOpts,
): string {
  const cacheKey = commuterContextCacheKey(opts);
  const cached = COMMUTER_CONTEXT_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  if (COMMUTER_CONTEXT_CACHE.size >= COMMUTER_CONTEXT_CACHE_MAX) {
    throw new Error(
      `renderJobBoardCommuterContext memo cache exceeded maxSize=${COMMUTER_CONTEXT_CACHE_MAX}. ` +
      `Last key: ${JSON.stringify(opts)}. ` +
      `Either raise the cap (if cardinality is genuinely bounded) or remove the offending ` +
      `per-page parameter from opts so the cache key space stays bounded.`,
    );
  }

  const {
    locale,
    location,
    sectorOrType = null,
    omitCommute = false,
    cantonDisplay = null,
    cantonSlot = null,
    cantonEntityName = null,
  } = opts;
  const row = omitCommute ? null : resolveCommuteRow(location);
  const copy = COPY[locale];
  const nationalScope = isSwitzerlandLocation(location);
  const commuterH = nationalScope
    ? locale === 'it'
      ? 'Vivere in Italia e lavorare in Svizzera: orientarsi tra i cantoni'
      : locale === 'en'
      ? 'Living in Italy and working in Switzerland: navigating the cantons'
      : locale === 'de'
      ? 'In Italien wohnen und in der Schweiz arbeiten: Orientierung zwischen den Kantonen'
      : 'Vivre en Italie et travailler en Suisse : comprendre les cantons'
    : copy.commuterH;
  const salaryH = nationalScope
    ? locale === 'it'
      ? 'Stipendio lordo CHF: come stimare il netto tra i cantoni'
      : locale === 'en'
      ? 'CHF gross salary: estimating take-home across cantons'
      : locale === 'de'
      ? 'CHF-Bruttolohn: das Netto je nach Kanton einschätzen'
      : 'Salaire brut CHF : estimer le net selon le canton'
    : copy.salaryH;

  const commuterParagraph = omitCommute
    ? buildOmitCommuteParagraph(locale, location)
    : buildCommuterParagraph(locale, location, row);
  const salaryParagraph = buildSalaryParagraph(locale);
  const scenarioCallout = buildScenarioCallout(locale, location, row, nationalScope);
  const faq = buildFaq(locale, location, sectorOrType, isRegionLocation(location, cantonDisplay), nationalScope);
  const crossLinks = buildCrossLinks(locale, nationalScope);

  const faqHtml = faq
    .map(
      (f) =>
        `<details class="s-TdgkK3"><summary class="s-HBR0NM">${escAttr(f.q)}</summary><p class="s-bOIp6r">${f.a}</p></details>`,
    )
    .join('');

  // Optional canton-aware prose appended ONLY for non-TI canton editorial
  // pages. Adds ~5 KB of canton-specific intro/methodology/permit/FAQ/links
  // so the heavy host page (~95-145 KB) clears the 10 % Semrush text/HTML
  // gate that the legacy block alone could not reach for non-TI cantons.
  // TI keeps its byte-identical output (HARD INVARIANT per CLAUDE.md
  // non-negotiables #1, #5, #6).
  let cantonBlock = '';
  if (cantonDisplay && cantonDisplay.trim()) {
    const displayLower = cantonDisplay.trim().toLowerCase();
    const isTicino = displayLower === 'ticino' || displayLower === 'tessin';
    if (!isTicino) {
      const slot: CantonSeoSlot = cantonSlot || 'canton-hub';
      cantonBlock = getCantonProseBlock(
        locale,
        cantonDisplay.trim(),
        slot,
        cantonEntityName,
      );
    }
  }

  const html = `<section class="job-board-commuter-context s-A_RnbE">
  <h2 class="s-1kjxOy">${escAttr(copy.methodologyH)}</h2>
  <p class="s-clIDbe">${buildMethodology(locale, nationalScope)}</p>
  <h2 class="s-1kjxOy">${escAttr(commuterH)}</h2>
  <p class="s-clIDbe">${commuterParagraph}</p>
  <h2 class="s-1kjxOy">${escAttr(salaryH)}</h2>
  <p class="s-clIDbe">${salaryParagraph}</p>
  <p class="s--0PHnG">${scenarioCallout}</p>
  <h2 class="s-1kjxOy">${escAttr(copy.faqH)}</h2>
  ${faqHtml}
  <h2 class="s-WaVHtT">${escAttr(copy.ctaH)}</h2>
  <p class="s-clIDbe">${crossLinks}</p>
${cantonBlock}
</section>`;
  COMMUTER_CONTEXT_CACHE.set(cacheKey, html);
  return html;
}

/**
 * Public lookup: does the helper recognise this location as a Ticino city
 * with commute data? Used by callers that want to choose between the
 * city-aware path (`location: <City>`) and the general-Ticino fallback
 * (`location: 'Ticino', omitCommute: true`).
 */
export function isKnownTicinoCommuterCity(location: string): boolean {
  return resolveCommuteRow(location) !== null;
}

/**
 * Per-query opening paragraph for free-text search / keyword / combo job
 * landings (`/cerca-lavoro-ticino/ricerca-{slug}/` and equivalents in EN,
 * DE, FR). The paragraph references the actual user query verbatim so
 * each emitted page has a unique top section, avoiding the template-wide
 * duplication penalty Google applies to thin search-results pages.
 *
 * The helper is pure; identical inputs always produce identical output
 * (no Date.now, no Math.random) so determinism tests in the gate suite
 * still pass.
 *
 * @param locale     Output locale.
 * @param query      Display form of the user query (e.g. "Educatori Vallese",
 *                   "Chur", "Lugano stage", "medico"). Whatever the page
 *                   heading shows the user.
 * @param matchCount Number of jobs surfaced for this query in the locale.
 * @param companies  Up to 3-5 unique company names visible on the page.
 * @param locations  Up to 3-5 unique location names visible on the page.
 */
/**
 * Geographic scope of the cluster the intro describes. `ticino` keeps the
 * original canton-scoped wording; `svizzera` switches to nation-wide wording
 * for the Switzerland-aggregate cluster pages (canonical `/cerca-lavoro-
 * svizzera/…`) whose job set spans every canton — saying "in Ticino" there
 * contradicted the listings (jobs in Bern, Zürich, Vaud, …).
 */
export type SearchQueryScope = 'ticino' | 'svizzera';

export function renderSearchQueryIntro(
  locale: CommuterLocale,
  query: string,
  matchCount: number,
  companies: string[],
  locations: string[],
  scope: SearchQueryScope = 'ticino',
): string {
  const q = (query || '').trim();
  const safeQ = q.length > 0 ? q : (locale === 'it' ? 'questa ricerca' : locale === 'en' ? 'this search' : locale === 'de' ? 'diese Suche' : 'cette recherche');
  const topCompanies = companies.slice(0, 4).map((c) => escAttr(c)).join(', ');
  const topLocations = locations.slice(0, 4).map((l) => escAttr(l)).join(', ');
  const hasCompanies = topCompanies.length > 0;
  const hasLocations = topLocations.length > 0;

  // Pick three rotating angles using a stable hash of the query so each
  // query gets a slightly different framing. No randomness — pure function.
  const angle = stableHash(`${q}|${locale}`) % 3;

  if (locale === 'it') {
    const regIn = scope === 'svizzera' ? 'in Svizzera' : 'in Ticino';
    const employersTail = scope === 'svizzera'
      ? 'aziende svizzere e dai principali ATS attivi sul territorio nazionale'
      : 'aziende ticinesi e dai principali ATS svizzeri attivi nel cantone';
    const intro = angle === 0
      ? `Questa pagina raccoglie le offerte attive ${regIn} legate alla ricerca <strong>"${escAttr(safeQ)}"</strong>: i ${matchCount} annunci qui sotto sono filtrati dal nostro indice di posizioni aperte e ordinati per data di pubblicazione, dalla più recente alla più vecchia.`
      : angle === 1
      ? `Stai cercando <strong>"${escAttr(safeQ)}"</strong> ${regIn}. Abbiamo indicizzato ${matchCount} posizioni aperte che corrispondono a questa query, raccolte dai portali carriera delle ${employersTail}.`
      : `Le ${matchCount} offerte raggruppate in questa pagina rispondono alla ricerca <strong>"${escAttr(safeQ)}"</strong>: sono filtrate dal nostro feed proprietario aggiornato ogni 6 ore e mostrano solo posizioni la cui scadenza non è ancora trascorsa.`;
    const context = `${hasCompanies ? `Tra i datori di lavoro che assumono per "${escAttr(safeQ)}" trovi ${topCompanies}. ` : ''}${hasLocations ? `Le località ricorrenti negli annunci sono ${topLocations}: tieni conto di tempi di pendolarismo e tipologia di valico (Brogeda, Stabio, Ponte Tresa) prima di scegliere un\'opportunità rispetto a un\'altra. ` : ''}${buildOmitCommuteParagraph(locale, scope === 'ticino' ? 'Ticino' : 'Svizzera')}`;
    const valueProp = `Sotto ogni annuncio trovi un link diretto alla pagina ufficiale di candidatura: non chiediamo registrazione, non intermediamo CV. Se vuoi confrontare il lordo CHF con il netto reale per la tua situazione (zona di frontiera vs Permesso B, vecchio vs nuovo accordo fiscale Italia-Svizzera 2024, presenza di figli a carico, telelavoro fino al 25 %), apri il calcolatore Frontaliere Ticino dal menu in alto: in 30 secondi ottieni la cifra netta mensile in CHF e in EUR.`;
    return `<p class="s-clIDbe">${intro}</p>\n<p class="s-clIDbe">${context}</p>\n<p class="s-clIDbe">${valueProp}</p>`;
  }
  if (locale === 'en') {
    const openings = scope === 'svizzera' ? 'openings across Switzerland' : 'Ticino openings';
    const regIn = scope === 'svizzera' ? 'across Switzerland' : 'in Ticino';
    const employersTail = scope === 'svizzera'
      ? 'Swiss employers\' career portals and the main Swiss ATS active nationwide'
      : 'Ticino employers\' career portals and the main Swiss ATS active in the canton';
    const intro = angle === 0
      ? `This page lists active ${openings} tied to the search <strong>"${escAttr(safeQ)}"</strong>: the ${matchCount} listings below are filtered from our open-position index and sorted from newest to oldest.`
      : angle === 1
      ? `You are looking for <strong>"${escAttr(safeQ)}"</strong> ${regIn}. We indexed ${matchCount} active positions matching this query, collected from ${employersTail}.`
      : `The ${matchCount} listings grouped on this page answer the search <strong>"${escAttr(safeQ)}"</strong>: filtered from our proprietary feed refreshed every 6 hours, showing only positions whose deadline has not passed.`;
    const context = `${hasCompanies ? `Employers hiring for "${escAttr(safeQ)}" include ${topCompanies}. ` : ''}${hasLocations ? `Recurring locations are ${topLocations}: factor in commute time and crossing type (Brogeda, Stabio, Ponte Tresa) before picking one opportunity over another. ` : ''}${buildOmitCommuteParagraph(locale, scope === 'ticino' ? 'Ticino' : 'Svizzera')}`;
    const valueProp = `Each listing links directly to the official application page: we never require registration and never intermediate CVs. To compare the CHF gross with real take-home for your specific situation (border zone vs Permit B, old vs new 2024 Italy-Switzerland fiscal agreement, dependent children, teleworking up to 25 %), open the Frontaliere Ticino calculator from the top menu: in 30 seconds you get the monthly net in CHF and EUR.`;
    return `<p class="s-clIDbe">${intro}</p>\n<p class="s-clIDbe">${context}</p>\n<p class="s-clIDbe">${valueProp}</p>`;
  }
  if (locale === 'de') {
    const regIn = scope === 'svizzera' ? 'in der Schweiz' : 'im Tessin';
    const employersTail = scope === 'svizzera'
      ? 'Karriereportalen Schweizer Arbeitgeber und den wichtigsten landesweit aktiven Schweizer ATS'
      : 'Karriereportalen der Tessiner Arbeitgeber und den wichtigsten Schweizer ATS im Kanton';
    const intro = angle === 0
      ? `Diese Seite sammelt aktive Stellen ${regIn} zur Suche <strong>"${escAttr(safeQ)}"</strong>: die ${matchCount} Anzeigen unten stammen aus unserem Index offener Positionen, sortiert nach Veröffentlichungsdatum von neu nach alt.`
      : angle === 1
      ? `Sie suchen <strong>"${escAttr(safeQ)}"</strong> ${regIn}. Wir haben ${matchCount} aktive Stellen indexiert, die auf diese Anfrage passen — gesammelt aus den ${employersTail}.`
      : `Die ${matchCount} Inserate auf dieser Seite beantworten die Suche <strong>"${escAttr(safeQ)}"</strong>: gefiltert aus unserem eigenen Feed, alle 6 Stunden aktualisiert, mit ausschliesslich noch offenen Bewerbungsfristen.`;
    const context = `${hasCompanies ? `Zu den Arbeitgebern, die für "${escAttr(safeQ)}" rekrutieren, gehören ${topCompanies}. ` : ''}${hasLocations ? `Häufige Standorte sind ${topLocations}: Pendelzeit und Grenzübergang (Brogeda, Stabio, Ponte Tresa) sollten in die Wahl einer Stelle gegenüber einer anderen einfliessen. ` : ''}${buildOmitCommuteParagraph(locale, scope === 'ticino' ? 'Ticino' : 'Svizzera')}`;
    const valueProp = `Jedes Inserat führt direkt zur offiziellen Bewerbungsseite: wir verlangen keine Registrierung und vermitteln keine Lebensläufe. Um den CHF-Bruttolohn mit dem realen Netto für Ihre Situation zu vergleichen (Grenzzone vs. B-Bewilligung, altes vs. neues Steuerabkommen 2024, Kinderzulagen, Homeoffice bis 25 %), öffnen Sie den Frontaliere-Ticino-Rechner über das obere Menü: in 30 Sekunden erhalten Sie das Monatsnetto in CHF und EUR.`;
    return `<p class="s-clIDbe">${intro}</p>\n<p class="s-clIDbe">${context}</p>\n<p class="s-clIDbe">${valueProp}</p>`;
  }
  const regIn = scope === 'svizzera' ? 'en Suisse' : 'au Tessin';
  const employersTail = scope === 'svizzera'
    ? 'portails carrière des employeurs suisses et les principaux ATS suisses présents au niveau national'
    : 'portails carrière des employeurs tessinois et les principaux ATS suisses présents dans le canton';
  const intro = angle === 0
    ? `Cette page rassemble les offres actives ${regIn} liées à la recherche <strong>"${escAttr(safeQ)}"</strong> : les ${matchCount} annonces ci-dessous sont filtrées depuis notre index de postes ouverts et triées par date de publication, des plus récentes aux plus anciennes.`
    : angle === 1
    ? `Vous cherchez <strong>"${escAttr(safeQ)}"</strong> ${regIn}. Nous avons indexé ${matchCount} postes actifs correspondant à cette requête, collectés depuis les ${employersTail}.`
    : `Les ${matchCount} annonces regroupées sur cette page répondent à la recherche <strong>"${escAttr(safeQ)}"</strong> : filtrées depuis notre flux propriétaire actualisé toutes les 6 heures, ne montrant que les postes dont l\'échéance n\'est pas encore passée.`;
  const context = `${hasCompanies ? `Les employeurs qui recrutent pour "${escAttr(safeQ)}" incluent ${topCompanies}. ` : ''}${hasLocations ? `Les localités récurrentes sont ${topLocations} : prenez en compte le temps de trajet et le type de passage frontalier (Brogeda, Stabio, Ponte Tresa) avant de choisir une opportunité plutôt qu\'une autre. ` : ''}${buildOmitCommuteParagraph(locale, scope === 'ticino' ? 'Ticino' : 'Svizzera')}`;
  const valueProp = `Chaque annonce renvoie directement à la page de candidature officielle : nous ne demandons aucune inscription et n\'intermédions aucun CV. Pour comparer le brut CHF avec le net réel pour votre situation (zone frontalière vs permis B, ancien vs nouvel accord fiscal 2024, enfants à charge, télétravail jusqu\'à 25 %), ouvrez le calculateur Frontaliere Ticino depuis le menu supérieur : en 30 secondes vous obtenez le net mensuel en CHF et en EUR.`;
  return `<p class="s-clIDbe">${intro}</p>\n<p class="s-clIDbe">${context}</p>\n<p class="s-clIDbe">${valueProp}</p>`;
}

/**
 * Stable, fast non-cryptographic hash. Used to vary the opening-angle
 * choice across queries without introducing nondeterminism. djb2.
 */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h | 0);
}

/**
 * Generate FAQPage JSON-LD for the same FAQ block emitted by
 * `renderJobBoardCommuterContext`.
 *
 * Surfaces 4 Q&A pairs to Google's FAQ rich result.
 *
 * Callers that also emit AI-enriched FAQs on the same page MUST instead use
 * `buildJobBoardCommuterFaqItems` and merge the entries into a single
 * `FAQPage`; multiple `FAQPage` blocks on one page are flagged by GSC as
 * "Campo duplicato 'FAQPage'".
 */
export function buildJobBoardCommuterFaqLd(opts: JobBoardCommuterContextOpts): string {
  const { locale } = opts;
  const items = buildJobBoardCommuterFaqItems(opts);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: items,
  });
}

/**
 * Return the `mainEntity` array (Question + Answer Schema.org objects) for
 * the commuter-context FAQ block. Use this when the host page emits another
 * source of FAQs (e.g. AI enrichment) and needs to merge them into a single
 * `FAQPage` JSON-LD script to avoid GSC duplicate-FAQPage warnings.
 *
 * Memoised by (locale | location | sectorOrType). Pure function of the
 * 3-tuple — same cardinality as renderJobBoardCommuterContext (≈ 7-10k
 * unique keys across cathedral cantons × cities × sectors). Called ~102k
 * times from relatedSearchClustersPlugin + tens of thousands more from
 * jobsSeoPagesPlugin editorial emitters. Cap 30000 matches the sibling
 * renderJobBoardCommuterContext cache (fail-loud on cardinality blowup,
 * not a silent leak). Per-entry footprint ≈ 4 × ~200 B = ~1 KB so peak
 * heap headroom is ~30 MB — well under the CI 7 GB ceiling. The returned
 * array is reused (not deep-cloned) — callers MUST treat the result as
 * immutable. Today the only consumers are `JSON.stringify(...)` so the
 * shared-reference is safe.
 */
type FaqItem = {
  '@type': 'Question';
  name: string;
  acceptedAnswer: { '@type': 'Answer'; text: string };
};
const FAQ_ITEMS_CACHE = new Map<string, ReadonlyArray<FaqItem>>();
const FAQ_ITEMS_CACHE_MAX = 30000;

function faqItemsCacheKey(opts: JobBoardCommuterContextOpts): string {
  // The region flag is derived from (location, cantonDisplay) and changes the
  // emitted question wording, so it must be part of the key.
  return `${opts.locale}\x00${opts.location}\x00${opts.sectorOrType ?? ''}\x00${isRegionLocation(opts.location, opts.cantonDisplay) ? '1' : '0'}`;
}

export function buildJobBoardCommuterFaqItems(opts: JobBoardCommuterContextOpts): ReadonlyArray<FaqItem> {
  const cacheKey = faqItemsCacheKey(opts);
  const cached = FAQ_ITEMS_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  if (FAQ_ITEMS_CACHE.size >= FAQ_ITEMS_CACHE_MAX) {
    throw new Error(
      `buildJobBoardCommuterFaqItems memo cache exceeded maxSize=${FAQ_ITEMS_CACHE_MAX}. ` +
      `Last key: ${JSON.stringify({ locale: opts.locale, location: opts.location, sectorOrType: opts.sectorOrType ?? null })}. ` +
      `Either raise the cap (if cardinality is genuinely bounded) or remove the offending ` +
      `per-page parameter from opts so the cache key space stays bounded.`,
    );
  }

  const { locale, location, sectorOrType = null } = opts;
  const faq = buildFaq(locale, location, sectorOrType, isRegionLocation(location, opts.cantonDisplay), isSwitzerlandLocation(location));
  const items: ReadonlyArray<FaqItem> = faq
    .filter((f) => f.q && f.q.trim() && f.a && f.a.trim())
    .map((f) => ({
      '@type': 'Question' as const,
      name: f.q.trim(),
      acceptedAnswer: {
        '@type': 'Answer' as const,
        text: f.a.replace(/<[^>]+>/g, '').trim(),
      },
    }));
  FAQ_ITEMS_CACHE.set(cacheKey, items);
  return items;
}
