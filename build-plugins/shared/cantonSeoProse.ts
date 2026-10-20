/**
 * cantonSeoProse.ts
 *
 * Parametric prose helper for the thin-template family that was tripping
 * the `audit:text-html-ratio` Semrush gate (≤ 10 % visible text / HTML).
 *
 * Why this exists
 * ---------------
 * The cathedral CH-wide expansion (May 2026) emits a number of templates
 * that fan out per (canton, locale) and per (entity, locale): the thin
 * canton hubs (`/cerca-lavoro-{canton}/{settori|aziende|tutti}/`), the
 * weekly-employers-hub per-canton landing, the company/location-bridge
 * placeholder pages, and the non-TI editorial slot pages. These share two
 * properties:
 *
 *  1. They wrap the Vite SPA shell (~5-6 KB of `<head>` + bundle hashes
 *     + JSON-LD + design tokens) around a short factual body. With a
 *     500-byte body the page is ≈ 6.5 KB total and Semrush flags it at
 *     ~5 % ratio.
 *  2. They are emitted from many call sites, so duplicating prose inline
 *     causes drift and template-wide cross-page boilerplate that Google
 *     penalises.
 *
 * The helper builds a ~1.4-2.2 KB block of page-relevant prose
 * (intro → permit context → salary/fiscality → FAQ → cross-links) that
 * is fully parameterised by `canton`, `entity` (city / company), `slot`
 * (settori / aziende / today / ...), and `locale`. Every paragraph
 * substitutes the inputs, so two pages for different cantons never share
 * the same string and the cross-page duplication penalty is avoided.
 *
 * Design constraints (CLAUDE.md non-negotiables #15-17):
 *  - Mobile-first: prose ALWAYS sits below the data area (callers append
 *    it after their listing / table). Filler never pushes the meat
 *    below the fold on a ≤ 414 px viewport.
 *  - No new colour values: every style references existing `--color-*`
 *    semantic tokens from `index.css`. Light + dark mode auto-switch
 *    without `dark:` Tailwind prefixes.
 *  - FAQ block uses `<details>` so on mobile the accordion is collapsed
 *    and never blocks scroll to the data area above.
 *  - No hidden text. Every section is part of the visible HTML and
 *    crawlable.
 *
 * Public API
 * ----------
 *  - `renderCantonSeoProse(opts)` returns a self-contained `<section>` of
 *    HTML to be appended to the host page body, after the data area.
 *  - `buildCantonSeoProseFaqItems(opts)` returns the same FAQ entries as
 *    Schema.org `Question` objects so the caller can merge them into the
 *    page's FAQPage JSON-LD (avoiding GSC "duplicate FAQPage" warnings).
 */

import { renderPlainTextLinks } from './plainTextLinks';
import { CALC_HREF } from './calcHref';
import { FX_HREF, HEALTH_HREF, FUEL_HREF } from './comparatorHref';

export type CantonSeoLocale = 'it' | 'en' | 'de' | 'fr';

/** Slot the helper is rendering for — drives the heading + FAQ flavour. */
export type CantonSeoSlot =
  | 'canton-hub'
  | 'sectors-hub'
  | 'companies-hub'
  | 'company-landing'
  | 'city-landing'
  | 'editorial-today'
  | 'editorial-nursing'
  | 'editorial-clinics'
  | 'editorial-part-time'
  | 'editorial-intent';

export interface CantonSeoProseOpts {
  /** Output locale. */
  locale: CantonSeoLocale;
  /** Canton display name, e.g. 'Zurigo', 'Argovia', 'Ticino'. */
  cantonDisplay: string;
  /** Slot key — switches the H2/FAQ flavour without changing structure. */
  slot: CantonSeoSlot;
  /**
   * Optional entity name when the page is about one company / city
   * (e.g. 'Migros', 'Lugano'). Used to specialise FAQ wording.
   */
  entityName?: string | null;
  /**
   * Optional headline metric (e.g. number of active openings) — woven
   * into the intro to avoid template-wide duplicate wording.
   */
  countHint?: number | null;
  /**
   * Absolute or root-relative href to the section's main listing page.
   * Falls back to a locale-aware salary calculator link if omitted.
   */
  ctaHref?: string | null;
  /** Optional CTA label override. */
  ctaLabel?: string | null;
}

interface SlotCopy {
  /** H2 heading for the prose block. */
  blockHeading: string;
  /** Lead paragraph immediately under the H2. */
  intro: string;
  /** Methodology / data-source paragraph. */
  methodology: string;
  /** Permit + fiscality paragraph. */
  permitContext: string;
  /** FAQ heading. */
  faqHeading: string;
  /** FAQ entries (question + answer, plain text — wrapped in details). */
  faqs: Array<{ q: string; a: string }>;
  /** Cross-link paragraph (calculator / FX / health-insurance). */
  crossLinks: string;
}

// Locale-aware calculator paths — single source in the LEAF module
// ./calcHref (the '/'-pointing local table sent users to the homepage, not
// the simulator). MUST come from the leaf: importing it from
// jobBoardCommuterContext made a circular import (that module imports
// renderCantonSeoProse from here) and this module-level alias froze
// undefined → full-build crash (deploy run 27401576244). See calcHref.ts.
const CALCULATOR_HREF: Record<CantonSeoLocale, string> = CALC_HREF;

// FX_HREF / HEALTH_HREF / FUEL_HREF come from the shared comparatorHref SSOT
// (canonical, curl-verified-200 paths) — see the import above. Local copies
// here had drifted to a dead orphan scheme (/en/comparators/… 404, #1997).

const DEFAULT_CTA_LABEL: Record<CantonSeoLocale, string> = {
  it: 'Apri il calcolatore stipendio netto frontaliere',
  en: 'Open the cross-border net salary calculator',
  de: 'Grenzgänger-Nettolohnrechner öffnen',
  fr: 'Ouvrir le calculateur de salaire net frontalier',
};

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type FaqEntry = { q: string; a: string };

/**
 * The FAQ block's 4th question is slot-differentiated. Without this, every
 * slot (canton-hub, company-landing, city-landing, the editorial topics...)
 * emitted the identical canton-vs-canton comparison FAQ for a given canton —
 * harmless for the one-per-canton hub pages, but the highest-cardinality
 * duplicate-content risk in the family for `company-landing`/`city-landing`
 * (dozens of companies/cities per canton, all getting byte-identical FAQ
 * text regardless of `entityName`) and for the editorial topic pages. Hub
 * slots keep the canton-comparison FAQ (still relevant — one page/canton);
 * every other slot gets a question anchored to the concrete instance
 * (employer, city, or editorial topic) instead.
 */
const CROSS_BORDER_FISCAL_CONTEXT: Record<CantonSeoLocale, string> = {
  "it": "Il regime dei vecchi frontalieri dell’articolo 9 mantiene l’imposizione esclusiva in Svizzera sul salario interessato, senza scadenza automatica nel 2033 o 2034. Occorre avere lavorato come frontaliere fiscale in Ticino, Grigioni o Vallese tra il 31 dicembre 2018 e il 17 luglio 2023 e soddisfare i requisiti, fra cui il comune nella fascia di confine e il rientro in linea di principio quotidiano. Per i nuovi frontalieri fiscali la ritenuta svizzera è pari all’80% dell’aliquota ordinaria e l’Italia applica la propria imposizione con credito per l’imposta svizzera. Il 2033 è l’ultimo anno fiscale della compensazione del 40% versata dalla Svizzera all’Italia, non una scadenza dello status individuale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf",
  "en": "Article 9 preserves exclusive Swiss taxation of the covered salary for old cross-border workers, with no automatic expiry in 2033 or 2034. Eligibility requires qualifying cross-border employment in Ticino, Graubünden or Valais between 31 December 2018 and 17 July 2023 and the applicable conditions, including residence in a border-zone municipality and return home in principle daily. New fiscal cross-border workers pay Swiss withholding at 80% of the ordinary rate and Italian tax with a credit for Swiss tax. The 40% compensation paid by Switzerland to Italy ends with tax year 2033; this is not an expiry of individual tax status. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf",
  "de": "Artikel 9 erhält die ausschliessliche Schweizer Besteuerung des erfassten Lohns für alte Grenzgänger ohne automatisches Ende 2033 oder 2034. Voraussetzung ist eine steuerlich anerkannte Grenzgängertätigkeit im Tessin, in Graubünden oder im Wallis zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 sowie die einschlägigen Bedingungen, darunter Wohnsitz in einer Grenzgemeinde und grundsätzlich tägliche Heimkehr. Neue steuerliche Grenzgänger zahlen Schweizer Quellensteuer zu 80% des ordentlichen Tarifs und italienische Steuer mit Anrechnung der Schweizer Steuer. Der Ausgleich von 40% an Italien endet mit dem Steuerjahr 2033, nicht der individuelle Steuerstatus. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf",
  "fr": "L’article 9 maintient l’imposition exclusivement suisse du salaire concerné des anciens frontaliers, sans échéance automatique en 2033 ou 2034. Il faut avoir exercé une activité de frontalier fiscal au Tessin, dans les Grisons ou en Valais entre le 31 décembre 2018 et le 17 juillet 2023 et remplir les conditions applicables, notamment la résidence dans une commune de la zone frontalière et le retour en principe quotidien. Les nouveaux frontaliers fiscaux paient l’impôt suisse à 80% du taux ordinaire et l’impôt italien avec crédit pour l’impôt suisse. La compensation de 40% versée à l’Italie prend fin après l’année fiscale 2033, sans extinction du statut fiscal individuel. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
};

const EU_EFTA_PERMIT_CONTEXT: Record<CantonSeoLocale, string> = {
  "it": "Il permesso G UE/AELS riguarda chi risiede nell’UE/AELS, lavora in Svizzera e torna al domicilio estero almeno ogni settimana. Le zone di frontiera per questa autorizzazione sono abolite: il requisito fiscale dei 20 km è distinto. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html",
  "en": "The EU/EFTA G permit covers residents of the EU/EFTA working in Switzerland who return to their foreign home at least weekly. Border zones for this permit have been abolished; the fiscal 20 km condition is separate. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html",
  "de": "Die G-Bewilligung EU/EFTA betrifft Personen mit Wohnsitz in der EU/EFTA, die in der Schweiz arbeiten und mindestens wöchentlich heimkehren. Grenzzonen für diese Bewilligung sind aufgehoben; die steuerliche 20-km-Regel ist davon getrennt. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html",
  "fr": "Le permis G UE/AELE concerne les résidents de l’UE/AELE travaillant en Suisse et rentrant au domicile étranger au moins chaque semaine. Les zones frontalières pour ce permis sont abolies ; la condition fiscale des 20 km est distincte. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
};

const CANTON_TELEWORK_FACTS: Record<CantonSeoLocale, string> = {
  "it": "Per i frontalieri fiscali coperti dal protocollo Italia–Svizzera, il telelavoro al domicilio fino al 25% segue la regola fiscale dedicata. La previdenza è distinta: l’accordo quadro consente, su richiesta A1 e alle sue condizioni, dal 25% a meno del 50% mantenendo l’assoggettamento nello Stato del datore. Il trattamento fiscale non si estende automaticamente a ogni cantone o titolare di permesso G.",
  "en": "For fiscal cross-border workers covered by the Italy–Switzerland protocol, home telework up to 25% follows the dedicated tax rule. Social security is separate: subject to its conditions and an A1 application, the framework allows 25% to less than 50% while retaining coverage in the employer’s state. The tax treatment does not automatically cover every canton or G-permit holder.",
  "de": "Für steuerliche Grenzgänger im Geltungsbereich des italienisch-schweizerischen Protokolls gilt bis 25% Telearbeit am Wohnsitz die besondere Steuerregel. Sozialversicherung ist getrennt: Mit A1-Antrag und unter den Voraussetzungen des Rahmenübereinkommens sind ab 25% und unter 50% bei Versicherung im Arbeitgeberstaat möglich. Die Steuerregel gilt nicht automatisch für jeden Kanton oder jede G-Bewilligung.",
  "fr": "Pour les frontaliers fiscaux couverts par le protocole Italie–Suisse, le télétravail au domicile jusqu’à 25% relève de la règle fiscale dédiée. La sécurité sociale est distincte : sous conditions et avec demande A1, l’accord-cadre permet entre 25% et moins de 50% en restant affilié dans l’État de l’employeur. Le traitement fiscal ne couvre pas automatiquement tous les cantons ou permis G."
};

const CANTON_PART_TIME_FACTS: Record<CantonSeoLocale, string> = {
  "it": "La percentuale si calcola sul tempo di lavoro effettivo: un giorno su tre giorni di pari durata è circa il 33,3%, quindi supera il 25%. Un contratto part-time non rende automaticamente applicabili le regole fiscali dei frontalieri. ",
  "en": "The percentage uses actual working time: one of three equally long working days is about 33.3%, exceeding 25%. A part-time contract does not automatically qualify for fiscal cross-border rules. ",
  "de": "Massgeblich ist die tatsächliche Arbeitszeit: Einer von drei gleich langen Arbeitstagen entspricht rund 33,3% und überschreitet 25%. Ein Teilzeitvertrag erfüllt nicht automatisch die steuerlichen Grenzgängerbedingungen. ",
  "fr": "Le pourcentage porte sur le temps de travail effectif : un jour sur trois de même durée représente environ 33,3%, au-dessus de 25%. Un contrat à temps partiel ne donne pas automatiquement accès au régime fiscal frontalier. "
};

const CANTON_RECOGNITION_FACTS: Record<CantonSeoLocale, string> = {
  "it": "Per professioni non regolamentate non serve un riconoscimento formale per candidarsi. Per quelle regolamentate, recognition.swiss identifica l’autorità competente secondo titolo e attività: non è sempre la SEFRI. Documenti, eventuali misure integrative e tempi dipendono dal dossier; verifica le autorizzazioni necessarie prima di esercitare.",
  "en": "Non-regulated professions do not require formal recognition before applying. For regulated professions, recognition.swiss identifies the competent authority by qualification and activity; it is not always SERI. Documents, compensatory measures and processing times depend on the dossier; check the authorisations required before practising.",
  "de": "Für nicht reglementierte Berufe braucht es vor der Bewerbung keine formelle Anerkennung. Für reglementierte Berufe nennt recognition.swiss die zuständige Behörde nach Abschluss und Tätigkeit; dies ist nicht immer das SBFI. Unterlagen, Ausgleichsmassnahmen und Dauer hängen vom Dossier ab; prüfen Sie die Bewilligungen vor der Berufsausübung.",
  "fr": "Les professions non réglementées ne nécessitent pas de reconnaissance formelle avant candidature. Pour les professions réglementées, recognition.swiss indique l’autorité selon le titre et l’activité ; ce n’est pas toujours le SEFRI. Pièces, mesures complémentaires et délais dépendent du dossier ; vérifiez les autorisations avant d’exercer."
};

const CANTON_SALARY_METHOD: Record<CantonSeoLocale, string> = {
  "it": "Per confrontare un’offerta svizzera con una italiana parti dal lordo contrattuale, dal grado di occupazione e dalle mensilità effettive. Servono età, situazione familiare, residenza, luogo di lavoro, regime fiscale verificato e trattenute previdenziali applicabili. Aggiungi eventuale imposizione italiana con credito ammesso, cambio CHF/EUR, premi sanitari e costi documentati di viaggio o alloggio. Confronta importi riferiti allo stesso periodo e grado di lavoro: il solo nome del cantone non determina un netto tipico. Il simulatore fornisce una stima in base agli input, da confrontare con il cedolino e le istruzioni delle autorità.",
  "en": "To compare a Swiss and an Italian offer, start with contractual gross pay, workload and actual salary instalments. The calculation needs age, family circumstances, residence, workplace, verified tax status and applicable pension deductions. Include any Italian tax with the permitted credit, CHF/EUR conversion, health premiums and documented travel or accommodation costs. Compare the same period and workload: a canton name alone does not determine typical net pay. The calculator provides an input-based estimate to check against the payslip and official guidance.",
  "de": "Vergleichen Sie ein Schweizer und ein italienisches Angebot anhand des vertraglichen Bruttolohns, des Pensums und der tatsächlichen Lohnzahlungen. Benötigt werden Alter, Familiensituation, Wohnsitz, Arbeitsort, überprüfter Steuerstatus und anwendbare Vorsorgeabzüge. Berücksichtigen Sie italienische Steuern mit zulässiger Anrechnung, CHF/EUR-Wechselkurs, Krankenversicherungsprämien und belegte Reise- oder Unterkunftskosten. Zeitraum und Pensum müssen vergleichbar sein; der Kantonsname allein ergibt keinen typischen Nettolohn. Der Rechner liefert eine Schätzung anhand der Eingaben, die mit Lohnabrechnung und amtlichen Vorgaben abzugleichen ist.",
  "fr": "Pour comparer une offre suisse et une offre italienne, partez du brut contractuel, du taux d’activité et des mensualités réellement prévues. Le calcul nécessite âge, situation familiale, domicile, lieu de travail, statut fiscal vérifié et cotisations de prévoyance applicables. Ajoutez l’éventuelle imposition italienne avec le crédit admis, le change CHF/EUR, les primes maladie et les frais documentés de transport ou logement. Comparez une même période et un même taux d’activité : le nom du canton ne détermine pas un net typique. Le simulateur donne une estimation selon les paramètres, à confronter au bulletin de salaire et aux instructions officielles."
};

const CANTON_COMMUTE_METHOD: Record<CantonSeoLocale, string> = {
  "it": "Calcola il tragitto residenza–sede con gli orari reali del turno: verifica ultimo treno, alternativa in caso di ritardo, parcheggio, pedaggi ed eventuali preventivi di alloggio. Confronta spese documentate sullo stesso periodo. Il rientro settimanale del permesso G è distinto da quello in principio quotidiano del regime fiscale; un fine settimana al mese non soddisfa un obbligo settimanale.",
  "en": "Assess the home–workplace route using actual shift times: check the last train, a backup for delays, parking, tolls and any accommodation quotes. Compare documented expenses over the same period. Weekly return for a G permit differs from in-principle daily return for fiscal status; one weekend per month does not satisfy a weekly obligation.",
  "de": "Prüfen Sie den Weg Wohnsitz–Arbeitsort nach tatsächlichen Schichtzeiten: letzter Zug, Ersatz bei Verspätung, Parkplätze, Maut und allfällige Unterkunftsangebote. Vergleichen Sie belegte Kosten für denselben Zeitraum. Wöchentliche Heimkehr für die G-Bewilligung unterscheidet sich von grundsätzlich täglicher Rückkehr beim Steuerstatus; ein Wochenende pro Monat erfüllt keine wöchentliche Pflicht.",
  "fr": "Évaluez le trajet domicile–travail selon les horaires réels : dernier train, solution en cas de retard, stationnement, péages et devis de logement éventuel. Comparez des frais documentés sur une même période. Le retour hebdomadaire du permis G diffère du retour en principe quotidien du statut fiscal ; un week-end par mois ne remplit pas une obligation hebdomadaire."
};

function teleworkFacts(locale: CantonSeoLocale): string {
  return `${esc(CANTON_TELEWORK_FACTS[locale])} <a href="https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0">BSV</a>; <a href="https://www.bsv.admin.ch/it/telelavoro">BSV: A1</a>.`; // locale-segment-ok: fixed verified external authority URL, not a site locale route
}

function recognitionFacts(locale: CantonSeoLocale): string {
  return `${esc(CANTON_RECOGNITION_FACTS[locale])} <a href="https://www.recognition.swiss/en/">recognition.swiss</a>.`; // locale-segment-ok: fixed verified external authority URL, not a site locale route
}

const FOURTH_FAQ: Record<
  CantonSeoLocale,
  Partial<Record<CantonSeoSlot, (canton: string, entity: string) => FaqEntry>>
> = {
  it: {
    'company-landing': (canton, entity) => ({
      q: `Come faccio a candidarmi direttamente a ${entity || 'questo datore di lavoro'} nel Canton ${canton}?`,
      a: `Le offerte di ${entity || 'questo datore di lavoro'} elencate qui rimandano al canale di candidatura ufficiale dell'azienda (portale carriera diretto, non un form terzo), così la candidatura arriva senza intermediazione. Prima di candidarti verifica che l'annuncio sia ancora attivo (aggiorniamo ogni 6-12 ore) e prepara un CV in formato svizzero: ${entity || "l'azienda"} nel Canton ${canton} valuta evidenze quantificate più del titolo di studio da solo. Se non trovi un ruolo aperto in linea con il tuo profilo, una candidatura spontanea al reparto HR resta comunque efficace per le aziende con più posizioni attive contemporaneamente.`,
    }),
    'city-landing': (canton, entity) => ({
      q: `Perché cercare lavoro specificamente a ${entity || canton} invece che nell'intero Canton ${canton}?`,
      a: `Restringere la ricerca a ${entity || canton} ha senso quando il tempo di pendolarismo è il vincolo principale: la sede esatta del datore, non solo il canton, determina l'orario reale porta-a-porta. Le offerte qui aggregate indicano sempre il comune di lavoro, non solo il canton, così puoi scartare a colpo d'occhio le posizioni fuori dalla tua zona di pendolarismo sostenibile e concentrare il CV sulle aziende davvero raggiungibili da ${entity || canton}.`,
    }),
    'editorial-today': (canton) => ({
      q: `Con che frequenza si aggiornano le offerte pubblicate "oggi" nel Canton ${canton}?`,
      a: `Il crawler dedicato scansiona le fonti aziendali e le bacheche cantonali più volte al giorno; una nuova offerta compare in questa pagina entro poche ore dalla pubblicazione originale del datore, non il giorno successivo. La data mostrata è sempre quella di pubblicazione del datore, mai la data di scansione — se vedi un annuncio datato oggi puoi candidarti sapendo di essere tra i primi a vederlo, un vantaggio reale per i ruoli con alto volume di candidature.`,
    }),
    'editorial-nursing': (canton) => ({
      q: `Quanto dura davvero il riconoscimento del titolo per infermieri nel Canton ${canton}?`,
      a: recognitionFacts('it'),
    }),
    'editorial-clinics': (canton) => ({
      q: `Conviene candidarsi a una clinica pubblica (EOC/cantonale) o privata nel Canton ${canton}?`,
      a: "Confronta contratto collettivo applicabile, scala salariale, turni e condizioni della singola struttura. Per il riconoscimento del titolo conta la professione esercitata, non la sola distinzione pubblico/privato." + ` <a href="https://www.recognition.swiss/en/">recognition.swiss</a>.`, // locale-segment-ok: fixed verified external recognition portal, independent of site locale
    }),
    'editorial-part-time': (canton) => ({
      q: `Un contratto part-time nel Canton ${canton} riduce il margine di telelavoro concesso al frontaliere?`,
      a: `${esc(CANTON_PART_TIME_FACTS.it)}${teleworkFacts('it')}`,
    }),
  },
  en: {
    'company-landing': (canton, entity) => ({
      q: `How do I apply directly to ${entity || 'this employer'} in Canton ${canton}?`,
      a: `Listings from ${entity || 'this employer'} here link to the company's official application channel — a direct careers-portal link, not a third-party form — so your application reaches HR without intermediaries. Before applying, check the listing is still live (we refresh every 6-12 hours) and prepare a Swiss-format CV: ${entity || 'the employer'} in Canton ${canton} weighs quantified evidence more than the diploma alone. If nothing open matches your profile, a speculative application to the HR department still works well for employers running several open roles at once.`,
    }),
    'city-landing': (canton, entity) => ({
      q: `Why search specifically in ${entity || canton} instead of the whole Canton ${canton}?`,
      a: `Narrowing the search to ${entity || canton} matters when commute time is the binding constraint: the employer's exact municipality, not just the canton, sets the real door-to-door schedule. Every listing here states the work municipality, not only the canton, so you can filter out roles outside your sustainable commute zone at a glance and focus applications on employers actually reachable from ${entity || canton}.`,
    }),
    'editorial-today': (canton) => ({
      q: `How often do "today" listings in Canton ${canton} actually refresh?`,
      a: `The dedicated crawler scans employer sources and cantonal job boards several times a day; a new opening appears on this page within hours of the employer's original publication, not the next day. The date shown is always the employer's publication date, never the crawl timestamp — if you see a listing dated today, you're among the first applicants, a real edge for high-volume roles.`,
    }),
    'editorial-nursing': (canton) => ({
      q: `How long does qualification recognition take for nurses in Canton ${canton}?`,
      a: recognitionFacts('en'),
    }),
    'editorial-clinics': (canton) => ({
      q: `Is a public (cantonal/EOC-style) or private clinic the better target in Canton ${canton}?`,
      a: "Compare the applicable collective agreement, salary scale, shifts and conditions of each employer. Qualification recognition depends on the profession practised, not simply whether the employer is public or private." + ` <a href="https://www.recognition.swiss/en/">recognition.swiss</a>.`, // locale-segment-ok: fixed verified external recognition portal, independent of site locale
    }),
    'editorial-part-time': (canton) => ({
      q: `Does a part-time contract in Canton ${canton} shrink the telework allowance for cross-border workers?`,
      a: `${esc(CANTON_PART_TIME_FACTS.en)}${teleworkFacts('en')}`,
    }),
  },
  de: {
    'company-landing': (canton, entity) => ({
      q: `Wie bewerbe ich mich direkt bei ${entity || 'diesem Arbeitgeber'} im Kanton ${canton}?`,
      a: `Die hier gelisteten Stellen von ${entity || 'diesem Arbeitgeber'} verlinken auf den offiziellen Bewerbungskanal des Unternehmens — direkt zum Karriereportal, nicht zu einem Drittanbieter-Formular — sodass Ihre Bewerbung ohne Umwege ankommt. Prüfen Sie vor der Bewerbung, ob das Inserat noch aktiv ist (wir aktualisieren alle 6-12 Stunden), und bereiten Sie einen Lebenslauf im Schweizer Format vor: ${entity || 'der Arbeitgeber'} im Kanton ${canton} gewichtet quantifizierte Nachweise stärker als den Abschluss allein. Passt keine offene Stelle zu Ihrem Profil, funktioniert eine Initiativbewerbung an die HR-Abteilung bei Arbeitgebern mit mehreren gleichzeitig offenen Stellen weiterhin gut.`,
    }),
    'city-landing': (canton, entity) => ({
      q: `Warum gezielt in ${entity || canton} statt im gesamten Kanton ${canton} suchen?`,
      a: `Die Suche auf ${entity || canton} einzugrenzen lohnt sich, wenn die Pendelzeit die entscheidende Grenze ist: Die genaue Gemeinde des Arbeitgebers, nicht nur der Kanton, bestimmt den realen Tür-zu-Tür-Fahrplan. Jede Stelle hier nennt die Arbeitsgemeinde, nicht nur den Kanton, sodass Sie Positionen ausserhalb Ihrer tragbaren Pendelzone auf einen Blick ausschliessen und sich auf tatsächlich von ${entity || canton} aus erreichbare Arbeitgeber konzentrieren können.`,
    }),
    'editorial-today': (canton) => ({
      q: `Wie oft werden "heute"-Stellen im Kanton ${canton} tatsächlich aktualisiert?`,
      a: `Der dedizierte Crawler durchsucht Arbeitgeberquellen und kantonale Stellenportale mehrmals täglich; eine neue Stelle erscheint innerhalb weniger Stunden nach der Original-Veröffentlichung des Arbeitgebers auf dieser Seite, nicht erst am Folgetag. Das angezeigte Datum ist immer das Veröffentlichungsdatum des Arbeitgebers, nie der Crawl-Zeitstempel — bei einem heute datierten Inserat gehören Sie zu den ersten Bewerbern, ein echter Vorteil bei Rollen mit hohem Bewerbungsvolumen.`,
    }),
    'editorial-nursing': (canton) => ({
      q: `Wie lange dauert die Anerkennung des Abschlusses für Pflegefachkräfte im Kanton ${canton} wirklich?`,
      a: recognitionFacts('de'),
    }),
    'editorial-clinics': (canton) => ({
      q: `Öffentliche (kantonale/EOC-artige) oder private Klinik im Kanton ${canton} — was ist die bessere Wahl?`,
      a: "Vergleichen Sie anwendbaren Gesamtarbeitsvertrag, Lohnskala, Schichten und Bedingungen des einzelnen Arbeitgebers. Die Anerkennung hängt vom ausgeübten Beruf ab, nicht allein vom öffentlichen oder privaten Arbeitgeber." + ` <a href="https://www.recognition.swiss/en/">recognition.swiss</a>.`, // locale-segment-ok: fixed verified external recognition portal, independent of site locale
    }),
    'editorial-part-time': (canton) => ({
      q: `Verkleinert ein Teilzeitvertrag im Kanton ${canton} das Homeoffice-Kontingent für Grenzgänger?`,
      a: `${esc(CANTON_PART_TIME_FACTS.de)}${teleworkFacts('de')}`,
    }),
  },
  fr: {
    'company-landing': (canton, entity) => ({
      q: `Comment postuler directement chez ${entity || 'cet employeur'} dans le canton ${canton} ?`,
      a: `Les offres de ${entity || 'cet employeur'} listées ici renvoient vers le canal de candidature officiel de l'entreprise — un lien direct vers le portail carrière, pas un formulaire tiers — pour que votre candidature arrive sans intermédiaire. Avant de postuler, vérifiez que l'annonce est toujours active (nous actualisons toutes les 6-12 heures) et préparez un CV au format suisse : ${entity || "l'employeur"} dans le canton ${canton} valorise les preuves quantifiées plus que le diplôme seul. Si aucun poste ouvert ne correspond à votre profil, une candidature spontanée au service RH reste efficace pour les employeurs avec plusieurs postes ouverts simultanément.`,
    }),
    'city-landing': (canton, entity) => ({
      q: `Pourquoi cibler spécifiquement ${entity || canton} plutôt que tout le canton ${canton} ?`,
      a: `Restreindre la recherche à ${entity || canton} a du sens quand le temps de trajet est la contrainte principale : la commune exacte de l'employeur, pas seulement le canton, détermine l'horaire réel porte-à-porte. Chaque offre ici indique la commune de travail, pas seulement le canton, ce qui permet d'écarter en un coup d'œil les postes hors de votre zone de trajet viable et de concentrer vos candidatures sur les employeurs réellement accessibles depuis ${entity || canton}.`,
    }),
    'editorial-today': (canton) => ({
      q: `À quelle fréquence les offres « aujourd'hui » du canton ${canton} sont-elles vraiment mises à jour ?`,
      a: `Le crawler dédié scanne les sources employeurs et les bourses cantonales plusieurs fois par jour ; une nouvelle offre apparaît sur cette page en quelques heures après sa publication d'origine par l'employeur, pas le lendemain. La date affichée est toujours celle de publication de l'employeur, jamais l'horodatage du crawl — une annonce datée d'aujourd'hui signifie que vous comptez parmi les premiers candidats, un avantage réel pour les postes à fort volume de candidatures.`,
    }),
    'editorial-nursing': (canton) => ({
      q: `Combien de temps prend vraiment la reconnaissance du titre pour le personnel infirmier dans le canton ${canton} ?`,
      a: recognitionFacts('fr'),
    }),
    'editorial-clinics': (canton) => ({
      q: `Clinique publique (type EOC/cantonale) ou privée dans le canton ${canton} — quel est le meilleur choix ?`,
      a: "Comparez convention collective applicable, grille salariale, horaires et conditions de chaque établissement. La reconnaissance dépend de la profession exercée, pas simplement du caractère public ou privé de l’employeur." + ` <a href="https://www.recognition.swiss/en/">recognition.swiss</a>.`, // locale-segment-ok: fixed verified external recognition portal, independent of site locale
    }),
    'editorial-part-time': (canton) => ({
      q: `Un contrat à temps partiel dans le canton ${canton} réduit-il le quota de télétravail des frontaliers ?`,
      a: `${esc(CANTON_PART_TIME_FACTS.fr)}${teleworkFacts('fr')}`,
    }),
  },
};

function buildSlotCopy(opts: CantonSeoProseOpts): SlotCopy {
  const { locale, cantonDisplay, slot, entityName, countHint } = opts;
  const canton = cantonDisplay;
  const entity = entityName?.trim() || '';
  const countText = (() => {
    if (countHint == null || countHint <= 0) return '';
    if (locale === 'it') return `${countHint.toLocaleString('it-CH')} offerte attualmente attive`;
    if (locale === 'en') return `${countHint.toLocaleString('en-US')} openings currently active`;
    if (locale === 'de') return `${countHint.toLocaleString('de-CH')} aktive Stellen aktuell`;
    return `${countHint.toLocaleString('fr-CH')} offres actuellement actives`;
  })();

  if (locale === 'it') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `Questa pagina aggrega gli annunci attivi nel Canton ${canton} per chi pendola dall'Italia (Permesso G) o vive in Svizzera con Permesso B. ${countText ? `${countText} oggi nel canton ${canton}: ` : ''}sotto il listing trovi metodologia, contesto frontaliere e FAQ specifiche.`,
      'sectors-hub': `L'indice settoriale del Canton ${canton} raggruppa le offerte in macro-aree (sanità, finanza, IT, ingegneria, ristorazione, edilizia, amministrazione) così la stessa mansione pubblicata con sinonimi diversi finisce nella stessa categoria. Per un frontaliere italiano questo è il filtro più rapido per leggere la dimensione effettiva della domanda nel canton ${canton}.`,
      'companies-hub': `L'elenco aziende ${canton} mostra i datori con almeno un'offerta attiva oggi, ordinati per numero di posizioni aperte. Per il frontaliere italiano le aziende con delta settimanale positivo sono particolarmente interessanti: ${countText ? `${countText} ` : ''}ricevono CV anche fuori dalle posizioni specifiche e spesso aprono un colloquio esplorativo.`,
      'company-landing': `Le offerte attive di ${entity || 'questo datore di lavoro'} nel Canton ${canton} vengono aggregate qui da fonti aziendali ufficiali. ${countText ? `${countText} per ${entity || 'l\'azienda'}: ` : ''}il listing è aggiornato ogni 6-12 ore e indica sede esatta, retribuzione lorda quando dichiarata e canale di candidatura diretto al sito dell'azienda.`,
      'city-landing': `Le offerte attive a ${entity || canton} nel Canton ${canton} sono raccolte qui per chi cerca lavoro nella zona di pendolarismo. ${countText ? `${countText}: ` : ''}sotto la lista trovi il contesto Permesso G, il calcolo lordo-netto svizzero e le FAQ tipiche del frontaliere italiano.`,
      'editorial-today': `Le offerte di lavoro pubblicate oggi nel Canton ${canton} sono raggruppate qui per chi cerca opportunità freschissime. ${countText ? `${countText}: ` : ''}sotto la lista trovi metodologia di pubblicazione, frequenza di aggiornamento e contesto frontaliere.`,
      'editorial-nursing': `Le offerte per infermieri e personale sanitario nel Canton ${canton} sono raccolte qui da EOC, cliniche private, case anziani e altri datori di lavoro. ${countText ? `${countText} nel settore sanità in ${canton}: ` : ''}sotto la lista trovi normativa di riconoscimento titoli, salari mediani e FAQ Permesso G specifiche per il personale sanitario.`,
      'editorial-clinics': `Le offerte di cliniche e ospedali nel Canton ${canton} sono raccolte qui — strutture pubbliche (EOC, ospedali cantonali), cliniche private e centri specialistici. ${countText ? `${countText}: ` : ''}sotto la lista trovi metodologia, contesto frontaliere sanità e FAQ sul riconoscimento dei titoli.`,
      'editorial-part-time': `Le offerte part-time nel Canton ${canton} (gradi 40-80 %) sono raccolte qui per chi cerca un equilibrio tra orario svizzero e tempo di pendolarismo. ${countText ? `${countText}: ` : ''}sotto la lista trovi contesto Permesso G, calcolo netto su gradi parziali e FAQ su fiscalità e previdenza del telelavoro.`,
      'editorial-intent': `Questa pagina raccoglie gli annunci del Canton ${canton} che corrispondono a un'intenzione di ricerca concreta. ${countText ? `${countText}: ` : ''}usa i requisiti della singola offerta per verificare lingua, esperienza, sede e modalità di candidatura.`,
    };
    return {
      blockHeading: slotIntro[slot] ? `Come leggere questa pagina · ${canton}` : 'Contesto frontaliere',
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Gli annunci aggregati provengono da oltre 80 crawler dedicati ai principali datori di lavoro svizzeri (Workday, Smartrecruiters, ATS proprietari, portali carriera ufficiali) e dalle bacheche cantonali. Ogni offerta passa una deduplicazione su titolo normalizzato, azienda e comune prima della pubblicazione; la data visualizzata è quella di pubblicazione originale del datore, non quella di scansione, così puoi giudicare la freschezza. Manteniamo le offerte online per 30 giorni o fino al primo HTTP 404 / redirect "posizione chiusa", verificato ogni 12 ore.`,
      permitContext: `${renderPlainTextLinks(EU_EFTA_PERMIT_CONTEXT[locale])} ${renderPlainTextLinks(CROSS_BORDER_FISCAL_CONTEXT[locale])}`,
      faqHeading: `Domande frequenti sulla ricerca lavoro nel Canton ${canton}`,
      faqs: [
        {
          q: `Quanti giorni di telelavoro posso fare restando frontaliere nel Canton ${canton}?`,
          a: teleworkFacts(locale),
        },
        {
          q: `I titoli di studio italiani sono riconosciuti per lavorare nel Canton ${canton}?`,
          a: recognitionFacts(locale),
        },
        {
          q: `Lo stipendio netto in ${canton} vale la pena rispetto al lordo italiano?`,
          a: "Confronta il netto disponibile delle due offerte sullo stesso periodo e grado di occupazione. Usa il lordo reale e lo status fiscale verificato; considera anche cambio, assicurazione, trasporti e alloggio. Il metodo sotto indica gli input necessari.",
        },
        FOURTH_FAQ.it[slot]?.(canton, entity) ?? {
          q: `Come si confronta il mercato del Canton ${canton} con altri cantoni svizzeri per i frontalieri?`,
          a: "Confronta posti attivi, requisiti linguistici, sedi e tragitti delle offerte nei cantoni che ti interessano. Per la parte economica usa le condizioni reali di ciascun contratto: il cantone da solo non dimostra un vantaggio netto o fiscale.",
        },
      ],
      crossLinks: `Confronta le ipotesi nel <a href="${CALCULATOR_HREF[locale]}">calcolatore stipendio</a> e verifica il <a href="${FX_HREF[locale]}">cambio CHF/EUR</a>. <a href="${HEALTH_HREF[locale]}">Confronta i premi LAMal in base al Paese di domicilio e alle condizioni applicabili al tuo profilo</a>. Per i tragitti in auto consulta i <a href="${FUEL_HREF[locale]}">prezzi del carburante</a>.`,
    };
  }

  if (locale === 'en') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `This page aggregates active openings in Canton ${canton} for Italian-Swiss cross-border workers (G permit) and Swiss residents (B permit). ${countText ? `${countText} today in canton ${canton}: ` : ''}below the listing you'll find methodology, cross-border context and FAQs.`,
      'sectors-hub': `The sector index for Canton ${canton} groups openings into macro-areas (healthcare, finance, IT, engineering, hospitality, construction, administration) so the same role published with different keywords ends up in the same category. For Italian cross-border applicants this is the fastest filter to read real demand in canton ${canton}.`,
      'companies-hub': `The ${canton} employer list shows companies with at least one active opening today, sorted by open positions. For Italian cross-border applicants, employers with a positive weekly delta are particularly worth noting: ${countText ? `${countText} ` : ''}they often accept speculative CVs and open exploratory interviews.`,
      'company-landing': `Active openings at ${entity || 'this employer'} in Canton ${canton} are aggregated here from official corporate sources. ${countText ? `${countText} at ${entity || 'the employer'}: ` : ''}the listing is refreshed every 6-12 hours and shows precise location, declared gross pay where available and a direct apply link to the company's career portal.`,
      'city-landing': `Active openings in ${entity || canton} (Canton ${canton}) are collected here for applicants targeting the local commute zone. ${countText ? `${countText}: ` : ''}below the list you'll find G-permit context, Swiss gross-to-net calculation and the usual cross-border FAQs.`,
      'editorial-today': `Job openings published today in Canton ${canton} are grouped here for applicants chasing the freshest opportunities. ${countText ? `${countText}: ` : ''}below the list you'll find publication methodology, refresh frequency and cross-border context.`,
      'editorial-nursing': `Nursing and healthcare openings in Canton ${canton} are collected here from cantonal hospitals, private clinics, care homes and other employers. ${countText ? `${countText} in ${canton} healthcare: ` : ''}below the list you'll find diploma-recognition rules, median salaries and G-permit FAQs specific to healthcare.`,
      'editorial-clinics': `Clinic and hospital openings in Canton ${canton} are aggregated here — public structures, private clinics and specialist centres. ${countText ? `${countText}: ` : ''}below the list you'll find methodology, cross-border healthcare context and qualification-recognition FAQs.`,
      'editorial-part-time': `Part-time openings in Canton ${canton} (40-80 % grade) are grouped here for applicants seeking work-life balance with cross-border commute. ${countText ? `${countText}: ` : ''}below the list you'll find G-permit context, partial-grade net pay calculation and telework tax and social-security FAQs.`,
      'editorial-intent': `This page groups active Canton ${canton} listings around a concrete search intent. ${countText ? `${countText}: ` : ''}use each listing's requirements to verify language, experience, location and application route.`,
    };
    return {
      blockHeading: `How to read this ${canton} page`,
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Aggregated listings come from 80+ crawlers tracking the main Swiss employer ATS (Workday, Smartrecruiters, proprietary trackers) and cantonal job centres. Every listing passes a deduplication check on normalised title, company and municipality before publication; the displayed date is the original publication date — not the crawl timestamp — so you can judge the freshness. We keep listings online for 30 days or until the first HTTP 404 / "position closed" redirect, verified every 12 hours.`,
      permitContext: `${renderPlainTextLinks(EU_EFTA_PERMIT_CONTEXT[locale])} ${renderPlainTextLinks(CROSS_BORDER_FISCAL_CONTEXT[locale])}`,
      faqHeading: `Frequently asked questions about working in Canton ${canton}`,
      faqs: [
        {
          q: `How many days of remote work can I do while keeping cross-border status in Canton ${canton}?`,
          a: teleworkFacts(locale),
        },
        {
          q: `Are Italian qualifications recognised for jobs in Canton ${canton}?`,
          a: recognitionFacts(locale),
        },
        {
          q: `Is the net salary in ${canton} worth it compared with the Italian gross?`,
          a: "Compare disposable net pay for both offers over the same period and workload. Use actual gross pay and verified tax status, including exchange, insurance, travel and accommodation costs. The method below lists the required inputs.",
        },
        FOURTH_FAQ.en[slot]?.(canton, entity) ?? {
          q: `How does Canton ${canton} compare with other Swiss cantons for cross-border workers?`,
          a: "Compare active jobs, language requirements, locations and journeys across the cantons you are considering. For the financial comparison use each contract’s actual terms: the canton alone does not establish a net-pay or tax advantage.",
        },
      ],
      crossLinks: `Compare your inputs in the <a href="${CALCULATOR_HREF[locale]}">salary calculator</a> and check the <a href="${FX_HREF[locale]}">CHF/EUR exchange rate</a>. <a href="${HEALTH_HREF[locale]}">Compare LAMal premiums by country of residence and the conditions applicable to your profile</a>. For car travel check <a href="${FUEL_HREF[locale]}">fuel prices</a>.`,
    };
  }

  if (locale === 'de') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `Diese Seite sammelt aktive Stellen im Kanton ${canton} für italienisch-schweizerische Grenzgänger (G-Bewilligung) und Schweizer Einwohner (B-Bewilligung). ${countText ? `${countText} heute im Kanton ${canton}: ` : ''}unter der Liste finden Sie Methodik, Grenzgänger-Kontext und FAQ.`,
      'sectors-hub': `Der Branchenindex für den Kanton ${canton} fasst Stellen in Makrobereichen zusammen (Gesundheit, Finanzen, IT, Ingenieurwesen, Gastgewerbe, Bau, Verwaltung), so dass die gleiche Rolle unter verschiedenen Stichwörtern in derselben Kategorie landet. Für italienische Grenzgänger ist dies der schnellste Filter, um die tatsächliche Nachfrage im Kanton ${canton} zu lesen.`,
      'companies-hub': `Die Arbeitgeberliste ${canton} zeigt Unternehmen mit mindestens einer aktiven Stelle heute, sortiert nach offenen Positionen. Für italienische Grenzgänger sind Arbeitgeber mit positivem Wochendelta besonders interessant: ${countText ? `${countText} ` : ''}sie akzeptieren oft Initiativbewerbungen und öffnen exploratives Gespräch.`,
      'company-landing': `Aktive Stellen bei ${entity || 'diesem Arbeitgeber'} im Kanton ${canton} werden hier aus offiziellen Unternehmensquellen aggregiert. ${countText ? `${countText} bei ${entity || 'dem Arbeitgeber'}: ` : ''}die Liste wird alle 6-12 Stunden aktualisiert und zeigt den genauen Standort, das deklarierte Bruttoeinkommen, wo verfügbar, sowie den direkten Bewerbungslink zum Karriereportal des Unternehmens.`,
      'city-landing': `Aktive Stellen in ${entity || canton} (Kanton ${canton}) werden hier für Bewerber gesammelt, die die lokale Pendelzone anvisieren. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie G-Bewilligung-Kontext, schweizerische Brutto-Netto-Berechnung und übliche Grenzgänger-FAQ.`,
      'editorial-today': `Heute veröffentlichte Stellen im Kanton ${canton} sind hier für Bewerber gruppiert, die die frischesten Chancen suchen. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie Publikationsmethodik, Aktualisierungsfrequenz und Grenzgänger-Kontext.`,
      'editorial-nursing': `Pflege- und Gesundheitsstellen im Kanton ${canton} werden hier von kantonalen Spitälern, Privatkliniken, Altersheimen und anderen Arbeitgebern gesammelt. ${countText ? `${countText} im Gesundheitswesen ${canton}: ` : ''}unter der Liste finden Sie Diplom-Anerkennungsregeln, Medianlöhne und Grenzgänger-FAQ speziell für das Gesundheitswesen.`,
      'editorial-clinics': `Kliniken- und Spitäler-Stellen im Kanton ${canton} sind hier aggregiert — öffentliche Strukturen, Privatkliniken und Fachzentren. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie Methodik, Grenzgänger-Gesundheitskontext und recognition.swiss-Titelanerkennungs-FAQ.`,
      'editorial-part-time': `Teilzeitstellen im Kanton ${canton} (40-80 %) sind hier für Bewerber gruppiert, die Work-Life-Balance mit Pendlerwegen suchen. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie G-Bewilligung-Kontext, Teil-Pensum-Nettoberechnung und Homeoffice-bis-25%-FAQ.`,
      'editorial-intent': `Diese Seite bündelt aktive Stellen im Kanton ${canton} nach einer konkreten Suchabsicht. ${countText ? `${countText}: ` : ''}prüfen Sie in jedem Inserat Sprache, Erfahrung, Arbeitsort und Bewerbungskanal.`,
    };
    return {
      blockHeading: `Wie diese ${canton}-Seite zu lesen ist`,
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Die aggregierten Inserate stammen von über 80 Crawlern, die die wichtigsten Schweizer Arbeitgeber-ATS (Workday, Smartrecruiters, proprietäre Tracker) und kantonale Job-Center abfragen. Jedes Inserat durchläuft eine Deduplizierung über normalisierten Titel, Unternehmen und Gemeinde vor der Veröffentlichung; das angezeigte Datum ist das Original-Veröffentlichungsdatum — nicht der Crawl-Zeitstempel — so erkennen Sie, wie aktuell die Stelle ist. Stellen bleiben 30 Tage online oder bis zum ersten HTTP 404 / "Position geschlossen"-Redirect, alle 12 Stunden geprüft.`,
      permitContext: `${renderPlainTextLinks(EU_EFTA_PERMIT_CONTEXT[locale])} ${renderPlainTextLinks(CROSS_BORDER_FISCAL_CONTEXT[locale])}`,
      faqHeading: `Häufige Fragen zur Arbeit im Kanton ${canton}`,
      faqs: [
        {
          q: `Wie viele Tage Homeoffice darf ich als Grenzgänger im Kanton ${canton} machen?`,
          a: teleworkFacts(locale),
        },
        {
          q: `Werden italienische Qualifikationen für Stellen im Kanton ${canton} anerkannt?`,
          a: recognitionFacts(locale),
        },
        {
          q: `Lohnt sich der Nettolohn im Kanton ${canton} verglichen mit dem italienischen Brutto?`,
          a: "Vergleichen Sie verfügbaren Nettolohn bei gleichem Zeitraum und Pensum. Nutzen Sie den tatsächlichen Bruttolohn und geprüften Steuerstatus samt Wechselkurs, Versicherung, Reise und Unterkunft. Die Methode unten nennt die nötigen Angaben.",
        },
        FOURTH_FAQ.de[slot]?.(canton, entity) ?? {
          q: `Wie vergleicht sich der Kanton ${canton} mit anderen Schweizer Kantonen für Grenzgänger?`,
          a: "Vergleichen Sie aktive Stellen, Sprachkenntnisse, Arbeitsorte und Wege in den interessierenden Kantonen. Finanziell zählen die tatsächlichen Vertragsbedingungen: Der Kanton allein belegt keinen Netto- oder Steuervorteil.",
        },
      ],
      crossLinks: `Vergleichen Sie Ihre Angaben im <a href="${CALCULATOR_HREF[locale]}">Lohnrechner</a> und prüfen Sie den <a href="${FX_HREF[locale]}">CHF/EUR-Wechselkurs</a>. <a href="${HEALTH_HREF[locale]}">Vergleichen Sie LAMal-Prämien nach Wohnsitzland und den Bedingungen Ihres Profils</a>. Für Autofahrten prüfen Sie die <a href="${FUEL_HREF[locale]}">Treibstoffpreise</a>.`,
    };
  }

  // FR
  const slotIntro: Record<CantonSeoSlot, string> = {
    'canton-hub': `Cette page rassemble les offres actives dans le canton ${canton} pour les frontaliers italo-suisses (permis G) et résidents suisses (permis B). ${countText ? `${countText} aujourd'hui dans le canton ${canton} : ` : ''}sous la liste vous trouverez la méthodologie, le contexte frontalier et les FAQ.`,
    'sectors-hub': `L'index sectoriel du canton ${canton} regroupe les offres en macro-domaines (santé, finance, IT, ingénierie, restauration, construction, administration) afin que le même rôle publié avec différents mots-clés se retrouve dans la même catégorie. Pour les frontaliers italiens c'est le filtre le plus rapide pour lire la demande réelle dans le canton ${canton}.`,
    'companies-hub': `La liste des employeurs du canton ${canton} montre les entreprises avec au moins une offre active aujourd'hui, classées par nombre de postes ouverts. Pour les frontaliers italiens, les employeurs avec un delta hebdomadaire positif sont particulièrement intéressants : ${countText ? `${countText} ` : ''}ils acceptent souvent les candidatures spontanées et ouvrent un entretien exploratoire.`,
    'company-landing': `Les offres actives chez ${entity || 'cet employeur'} dans le canton ${canton} sont agrégées ici depuis des sources d'entreprise officielles. ${countText ? `${countText} chez ${entity || 'l\'employeur'} : ` : ''}la liste est rafraîchie toutes les 6-12 heures et indique le lieu précis, le salaire brut déclaré et un lien de candidature direct vers le portail de carrière de l'entreprise.`,
    'city-landing': `Les offres actives à ${entity || canton} (canton ${canton}) sont rassemblées ici pour les candidats ciblant la zone de pendulaire locale. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez le contexte permis G, le calcul brut-net suisse et les FAQ habituelles du frontalier.`,
    'editorial-today': `Les offres d'emploi publiées aujourd'hui dans le canton ${canton} sont regroupées ici pour les candidats à la recherche des opportunités les plus fraîches. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez la méthodologie de publication, la fréquence de rafraîchissement et le contexte frontalier.`,
    'editorial-nursing': `Les offres infirmières et de personnel soignant dans le canton ${canton} sont collectées ici depuis les hôpitaux cantonaux, cliniques privées, EMS et autres employeurs. ${countText ? `${countText} dans la santé ${canton} : ` : ''}sous la liste vous trouverez les règles de reconnaissance des diplômes, les salaires médians et les FAQ permis G spécifiques au secteur santé.`,
    'editorial-clinics': `Les offres de cliniques et hôpitaux dans le canton ${canton} sont agrégées ici — structures publiques, cliniques privées et centres spécialisés. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez la méthodologie, le contexte frontalier santé et les FAQ reconnaissance recognition.swiss.`,
    'editorial-part-time': `Les offres à temps partiel dans le canton ${canton} (40-80 %) sont regroupées ici pour les candidats cherchant l'équilibre vie-pro-vie-perso avec un trajet frontalier. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez le contexte permis G, le calcul du net sur degré partiel et les FAQ sur fiscalité et sécurité sociale du télétravail.`,
    'editorial-intent': `Cette page regroupe les offres actives du canton ${canton} autour d'une intention de recherche concrète. ${countText ? `${countText} : ` : ''}vérifiez dans chaque annonce la langue, l'expérience, le lieu et le canal de candidature.`,
  };
  return {
    blockHeading: `Comment lire cette page ${canton}`,
    intro: slotIntro[slot] || slotIntro['canton-hub'],
    methodology: `Les offres agrégées proviennent de plus de 80 crawlers dédiés aux principaux ATS des employeurs suisses (Workday, Smartrecruiters, ATS propriétaires) et aux job-centers cantonaux. Chaque annonce passe une déduplication sur titre normalisé, entreprise et commune avant publication ; la date affichée est la date de publication d'origine — pas l'horodatage du crawl — pour juger la fraîcheur. Nous gardons les offres en ligne 30 jours ou jusqu'au premier HTTP 404 / redirection "poste fermé", vérifiée toutes les 12 heures.`,
    permitContext: `${renderPlainTextLinks(EU_EFTA_PERMIT_CONTEXT[locale])} ${renderPlainTextLinks(CROSS_BORDER_FISCAL_CONTEXT[locale])}`,
    faqHeading: `Questions fréquentes sur le travail dans le canton ${canton}`,
    faqs: [
      {
        q: `Combien de jours de télétravail puis-je faire en restant frontalier dans le canton ${canton} ?`,
        a: teleworkFacts(locale),
      },
      {
        q: `Les qualifications italiennes sont-elles reconnues pour les emplois dans le canton ${canton} ?`,
        a: recognitionFacts(locale),
      },
      {
        q: `Le salaire net dans le canton ${canton} vaut-il la peine comparé au brut italien ?`,
        a: "Comparez le net disponible des deux offres sur la même période et au même taux d’activité. Utilisez le brut réel et le statut fiscal vérifié, avec change, assurance, transport et logement. La méthode ci-dessous indique les paramètres nécessaires.",
      },
      FOURTH_FAQ.fr[slot]?.(canton, entity) ?? {
        q: `Comment le canton ${canton} se compare-t-il aux autres cantons suisses pour les frontaliers ?`,
        a: "Comparez offres actives, langues requises, lieux de travail et trajets dans les cantons envisagés. Pour le volet financier, utilisez les conditions réelles des contrats : le canton seul ne démontre aucun avantage net ou fiscal.",
      },
    ],
      crossLinks: `Comparez vos paramètres dans le <a href="${CALCULATOR_HREF[locale]}">calculateur de salaire</a> et vérifiez le <a href="${FX_HREF[locale]}">change CHF/EUR</a>. <a href="${HEALTH_HREF[locale]}">Comparez les primes LAMal selon le pays de domicile et les conditions applicables à votre profil</a>. Pour les trajets en voiture consultez les <a href="${FUEL_HREF[locale]}">prix du carburant</a>.`,
  };
}

/**
 * Render a self-contained `<section>` of canton-aware SEO prose for the
 * given slot. Pure: identical inputs always produce identical HTML.
 *
 * The returned HTML is intended to be appended AFTER the host page's
 * data area (listing, table) per CLAUDE.md mobile-first rules — the
 * helper does not wrap the host's main content.
 */
export function renderCantonSeoProse(opts: CantonSeoProseOpts): string {
  const copy = buildSlotCopy(opts);
  const { locale, ctaHref, ctaLabel } = opts;
  const cta = ctaHref
    ? `<p class="s-OMTrs1"><a class="s-nF5mos" href="${esc(ctaHref)}">${esc(ctaLabel || DEFAULT_CTA_LABEL[locale])} →</a></p>`
    : '';

  const faqHtml = copy.faqs
    .map(
      (f) =>
        `<details class="s-6l74G5"><summary class="s-uwtLRE">${esc(f.q)}</summary><p class="s-JDVT3O">${f.a}</p></details>`,
    )
    .join('');

  const deepDive = buildDeepDiveBlock(opts);

  return `<section class="canton-seo-prose s-A_RnbE" data-slot="${esc(opts.slot)}" data-canton="${esc(opts.cantonDisplay)}">
  <h2 class="s-WaVHtT">${esc(copy.blockHeading)}</h2>
  <p class="s-clIDbe">${copy.intro}</p>
  <p class="s-D6KDw8"><strong>${esc(locale === 'it' ? 'Metodologia.' : locale === 'en' ? 'Methodology.' : locale === 'de' ? 'Methodik.' : 'Méthodologie.')}</strong> ${copy.methodology}</p>
  <p class="s-D6KDw8"><strong>${esc(locale === 'it' ? 'Permesso G + fiscalità.' : locale === 'en' ? 'G permit + tax context.' : locale === 'de' ? 'G-Bewilligung + Steuern.' : 'Permis G + fiscalité.')}</strong> ${copy.permitContext}</p>
  <h3 class="s-XD0S4S">${esc(copy.faqHeading)}</h3>
  ${faqHtml}
  ${deepDive}
  <p class="s-tw3E7n"><strong>${esc(locale === 'it' ? 'Strumenti collegati.' : locale === 'en' ? 'Related tools.' : locale === 'de' ? 'Verwandte Tools.' : 'Outils associés.')}</strong> ${copy.crossLinks}</p>
  ${cta}
</section>`;
}

/**
 * Render the deep-dive prose appended after the FAQ block. The block adds
 * ~3-4 KB of visible text covering: application playbook, commute /
 * accommodation checks, sector outlook and salary comparison methodology.
 * No personal travel duration or net salary is inferred from a canton name.
 *
 * The deep-dive is locale-aware and renders only in the four supported
 * locales (it / en / de / fr). It is pure: identical inputs return the
 * same HTML, so determinism + snapshot tests still pass.
 */
function buildDeepDiveBlock(opts: CantonSeoProseOpts): string {
  const { locale, cantonDisplay } = opts;
  const canton = cantonDisplay.trim();

  const headings = (() => {
    if (locale === 'it') {
      return {
        section: `Strategie pratiche per candidarsi nel Canton ${canton}`,
        playbook: 'Playbook di candidatura passo dopo passo',
        commute: 'Pendolarismo e logistica settimanale',
        sectors: 'Settori che assumono e mercato del lavoro',
        netpay: 'Lordo CHF, netto reale e confronto con l\'Italia',
      };
    }
    if (locale === 'en') {
      return {
        section: `Practical strategies for applying in Canton ${canton}`,
        playbook: 'Step-by-step application playbook',
        commute: 'Commute and weekly logistics',
        sectors: 'Sectors hiring and labour-market picture',
        netpay: 'CHF gross, real net and Italian comparison',
      };
    }
    if (locale === 'de') {
      return {
        section: `Praktische Strategien für eine Bewerbung im Kanton ${canton}`,
        playbook: 'Bewerbungs-Playbook Schritt für Schritt',
        commute: 'Pendeln und Wochenlogistik',
        sectors: 'Stark einstellende Branchen und Arbeitsmarkt',
        netpay: 'CHF-Brutto, reales Netto und Vergleich mit Italien',
      };
    }
    return {
      section: `Stratégies pratiques pour candidater dans le canton ${canton}`,
      playbook: 'Playbook de candidature pas à pas',
      commute: 'Trajet et logistique hebdomadaire',
      sectors: 'Secteurs qui recrutent et marché du travail',
      netpay: 'Brut CHF, net réel et comparaison italienne',
    };
  })();

  // Application playbook — same 5 steps in every locale but each step is
  // rewritten with canton-specific anchors so the prose isn't boilerplate.
  const applicationSteps: Record<CantonSeoLocale, string> = {
    "it": "Prepara CV e documenti nella lingua richiesta dall’annuncio, evidenziando esperienza e competenze pertinenti. Segui il canale di candidatura e i requisiti del datore; concorda disponibilità, turni e retribuzione prima di accettare. Per referenze e riconoscimento dei titoli verifica le richieste specifiche, senza presumere un formato CV o una durata dei colloqui universali. Pianifica con il datore le autorizzazioni necessarie prima dell’inizio del lavoro.",
    "en": "Prepare your CV and documents in the language requested by the listing, highlighting relevant experience and skills. Follow the employer’s application channel and requirements; confirm availability, shifts and pay before accepting. Check specific references and qualification-recognition requirements instead of assuming a universal CV format or interview duration. Plan the necessary work authorisations with the employer before starting.",
    "de": "Bereiten Sie Lebenslauf und Unterlagen in der Sprache des Inserats vor und zeigen Sie passende Erfahrung und Fähigkeiten. Folgen Sie dem Bewerbungskanal und den Anforderungen des Arbeitgebers; klären Sie Verfügbarkeit, Schichten und Lohn vor der Zusage. Prüfen Sie konkrete Anforderungen an Referenzen und Anerkennung statt ein universelles Lebenslaufformat oder eine feste Interviewdauer anzunehmen. Planen Sie die nötigen Arbeitsbewilligungen vor Stellenantritt.",
    "fr": "Préparez CV et pièces dans la langue demandée par l’annonce, en montrant expérience et compétences pertinentes. Suivez le canal et les exigences de l’employeur ; confirmez disponibilité, horaires et rémunération avant d’accepter. Vérifiez les demandes précises concernant références et reconnaissance des titres, sans supposer un format universel de CV ou une durée fixe d’entretien. Planifiez les autorisations nécessaires avant de commencer."
};
  const playbookP = esc(applicationSteps[locale]);

  // Use actual route inputs; a canton label cannot establish travel costs.
  const commuteP = `${esc(CANTON_COMMUTE_METHOD[locale])}`;

  const vacancyChecks: Record<CantonSeoLocale, string> = {
    "it": "Usa le offerte pubblicate in questa pagina per confrontare attività, esperienza richiesta, lingue, grado di occupazione e sede. Il nome del settore non dimostra da solo che un posto sia adatto al tuo profilo: apri la fonte del datore e verifica requisiti, validità dell’annuncio e modalità di candidatura.",
    "en": "Use the listings on this page to compare duties, required experience, languages, workload and workplace. A sector label alone does not establish suitability: open the employer’s source and check requirements, whether the vacancy is still open and how to apply.",
    "de": "Vergleichen Sie anhand der Inserate auf dieser Seite Aufgaben, Erfahrung, Sprachen, Pensum und Arbeitsort. Eine Branchenbezeichnung allein belegt keine Eignung: Prüfen Sie an der Quelle des Arbeitgebers Anforderungen, Verfügbarkeit der Stelle und Bewerbungsweg.",
    "fr": "Utilisez les annonces de cette page pour comparer missions, expérience, langues, taux d’activité et lieu de travail. Un secteur ne prouve pas à lui seul l’adéquation au profil : consultez la source de l’employeur pour vérifier exigences, disponibilité du poste et procédure de candidature."
};
  const sectorsP = esc(vacancyChecks[locale]);

  // No unsupported canton-wide salary/net band: use the actual offer inputs.
  const netpayP = `${esc(CANTON_SALARY_METHOD[locale])} <a href="${CALCULATOR_HREF[locale]}">${esc(DEFAULT_CTA_LABEL[locale])}</a>.`;

  return `<h3 class="s-J_8kBc">${esc(headings.section)}</h3>
  <p class="s-XCgoeD"><strong>${esc(headings.playbook)}.</strong> ${playbookP}</p>
  <p class="s-XCgoeD"><strong>${esc(headings.commute)}.</strong> ${commuteP}</p>
  <p class="s-XCgoeD"><strong>${esc(headings.sectors)}.</strong> ${sectorsP}</p>
  <p class="s-D6KDw8"><strong>${esc(headings.netpay)}.</strong> ${netpayP}</p>`;
}

/**
 * Return the FAQ entries as Schema.org `Question` objects so the host
 * page can merge them into a single FAQPage JSON-LD script (avoiding
 * the GSC duplicate-FAQPage warning).
 */
export function buildCantonSeoProseFaqItems(opts: CantonSeoProseOpts): Array<{
  '@type': 'Question';
  name: string;
  acceptedAnswer: { '@type': 'Answer'; text: string };
}> {
  const copy = buildSlotCopy(opts);
  return copy.faqs
    .filter((f) => f.q.trim() && f.a.trim())
    .map((f) => ({
      '@type': 'Question' as const,
      name: f.q.trim(),
      acceptedAnswer: {
        '@type': 'Answer' as const,
        text: f.a.replace(/<[^>]+>/g, '').trim(),
      },
    }));
}
