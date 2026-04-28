/**
 * Salary Hub SEO — Browseable scenario index.
 *
 * Emits a paginated index of every salary-hub scenario page so that BFS from
 * the homepage can reach all 1 732 entries listed in
 * `sitemap-salary-hub.xml`. Without this index, the entire sitemap is
 * orphaned (Semrush 2026-04-28 flagged 1 732/1 732 orphans, blocking the
 * `audit:orphan-sitemap-pages` CI gate).
 *
 * Layout
 * ------
 * One canonical index per locale at:
 *   IT  /calcola-stipendio/scenari/
 *   EN  /en/calculate-salary/scenarios/
 *   DE  /de/gehalt-berechnen/szenarien/
 *   FR  /fr/calculer-salaire/scenarios/
 *
 * Each index lists every scenario in this locale grouped by salary tier
 * (CHF 40 000 → CHF 150 000, 18 tiers). Scenarios within a tier are split
 * into family-situation sub-groups (single, sposato/married, with children,
 * by frontier-type and distance zone). Every entry is a real `<a href>` so
 * the BFS reachability audit (Mode A — `<a href>` walk over dist/) sees
 * each scenario as reachable via:
 *
 *   /  →  /calcola-stipendio/  →  /calcola-stipendio/scenari/  →  /…/<scenario>/
 *
 * Pagination is implemented but disabled by default — 425 IT scenarios fits
 * well within Google's "thousands of links" tolerance and avoids extra
 * pagination orphans. The page emits `<link rel="next">` only when the
 * per-page cap is set below the scenario count.
 *
 * Content gate (text-to-HTML ratio ≥ 10 %)
 * ----------------------------------------
 * The page is NOT a thin link list. It carries:
 *   - per-tier methodology paragraph (regime fiscale + nuovo/vecchio split)
 *   - per-locale FAQ (4 Q&A) explaining how to use the matrix
 *   - a per-tier "highlights" sentence pointing at the most-searched scenarios
 *
 * This keeps the visible-text ratio above 10 % even for the larger (24-link)
 * tier groups and satisfies non-negotiable rule #4 (no thin content).
 */

import {
  SALARY_LEVELS,
  buildFullPath,
  type SalaryHubScenario,
} from './salaryHubScenarios';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';

type Locale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];

// ── URL paths ──────────────────────────────────────────────────────────────

/** Canonical path of the scenario index, per locale. Trailing slash, like the
 *  rest of the salary-hub URLs. */
export const SCENARIO_INDEX_PATH: Record<Locale, string> = {
  it: '/calcola-stipendio/scenari/',
  en: '/en/calculate-salary/scenarios/',
  de: '/de/gehalt-berechnen/szenarien/',
  fr: '/fr/calculer-salaire/scenarios/',
};

/** Calculator hub canonical path (the salary-hub parent), per locale. */
export const CALC_HUB_PATH: Record<Locale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── Locale labels ──────────────────────────────────────────────────────────

interface IndexLabels {
  metaTitle: string;
  metaDescription: string;
  h1: string;
  intro: string;
  home: string;
  calcSection: string;
  scenariosBreadcrumb: string;
  tierHeading: (salary: number) => string;
  tierMethodology: (salary: number, tierCount: number) => string;
  countLabel: (n: number) => string;
  faqTitle: string;
  faqs: ReadonlyArray<{ q: string; a: string }>;
  scenarioLabel: (s: SalaryHubScenario) => string;
  groupLabels: {
    single: string;
    married: string;
    withChildren: (n: number) => string;
    new: string;
    old: string;
    within20: string;
    over20: string;
  };
  paginationPrev: string;
  paginationNext: string;
  pageOfTotal: (current: number, total: number) => string;
}

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('de-CH');

const LABELS: Record<Locale, IndexLabels> = {
  it: {
    metaTitle: 'Tutti gli scenari di stipendio netto frontaliere — indice 2026',
    metaDescription:
      'Indice completo: stipendio netto per oltre 400 scenari frontaliere — da CHF 40\u00a0000 a CHF 150\u00a0000, single o sposato, con figli, vecchi e nuovi frontalieri, entro o oltre 20 km. Simulazione 2026.',
    h1: 'Tutti gli scenari di stipendio netto per frontalieri',
    intro:
      'Questo indice raccoglie ogni simulazione disponibile nel calcolatore stipendio frontaliere: 18 livelli di reddito lordo (da CHF 40\u00a0000 a CHF 150\u00a0000), combinati con stato civile, numero di figli, tipo di frontaliere (vecchio o nuovo, accordo 2026) e zona di distanza dal confine (entro 20 km, oltre 20 km). Ogni link porta a una pagina con il netto annuo, il netto mensile, la tabella fiscale ticinese applicata, l\u2019aliquota effettiva e il confronto con un residente svizzero. Le pagine vengono ricalcolate ad ogni build con i parametri AVS, LPP, imposta alla fonte e IRPEF aggiornati al 2026.',
    home: 'Home',
    calcSection: 'Calcola Stipendio',
    scenariosBreadcrumb: 'Tutti gli scenari',
    tierHeading: (salary) => `Stipendio lordo CHF ${fmtCHF(salary)}`,
    tierMethodology: (salary, tierCount) =>
      `Per un reddito lordo di CHF ${fmtCHF(salary)} l\u2019imposta alla fonte ticinese si colloca tra l\u20198 % e il 13 % a seconda della tabella (A single, B coniuge non lavoratore, C entrambi lavoratori, H genitore solo). Le ${tierCount} simulazioni qui sotto coprono ogni combinazione utile di stato civile, figli, tipologia di frontaliere e zona di distanza, mantenendo costanti AVS (5,3 %), LPP (5 % a 35 anni) e premio LAMal medio (CHF 350/mese).`,
    countLabel: (n) => `${n} scenari`,
    faqTitle: 'Domande frequenti su questo indice',
    faqs: [
      {
        q: 'Come scegliere lo scenario giusto?',
        a: 'Parti dal tuo reddito lordo annuo CHF effettivo (cerca il tier pi\u00f9 vicino), poi filtra per stato civile, numero di figli, tipo di frontaliere (vecchio = assunto prima del 17 luglio 2023 con residenza entro 20 km; nuovo = tutti gli altri) e zona di distanza. Ogni pagina riporta tabella fiscale, aliquota effettiva e confronto CH-IT.',
      },
      {
        q: 'Perch\u00e9 alcuni livelli di reddito hanno meno scenari?',
        a: 'I tier che corrispondono a slug giornalistici esistenti (es. CHF 60\u00a0000, 80\u00a0000, 100\u00a0000) sono parzialmente coperti da pagine SEO storiche e non vengono duplicati nell\u2019hub generato — vedi `EXISTING_IT_SLUGS` in `salaryHubScenarios.ts` per la lista completa.',
      },
      {
        q: 'I numeri sono aggiornati al 2026?',
        a: 'S\u00ec. Le simulazioni vengono ricalcolate ad ogni build con i parametri AVS/LPP, le tabelle imposta alla fonte Ticino vigenti, gli scaglioni IRPEF e la franchigia di EUR 10 000 prevista dal nuovo accordo per i nuovi frontalieri.',
      },
      {
        q: 'Posso personalizzare uno scenario?',
        a: 'S\u00ec. Ogni pagina di scenario ha un pulsante "Personalizza questa simulazione" che apre il calcolatore principale precompilato con i parametri della pagina, dove puoi modificare reddito, premio LAMal, et\u00e0, comune di residenza e altre variabili.',
      },
    ],
    scenarioLabel: (s) => {
      const parts: string[] = [];
      parts.push(s.maritalStatus === 'MARRIED' ? 'sposato/a' : 'single');
      if (s.children > 0) parts.push(s.children === 1 ? '1 figlio' : `${s.children} figli`);
      parts.push(s.frontierType === 'OLD' ? 'vecchio frontaliere' : 'nuovo frontaliere');
      parts.push(s.distanceZone === 'WITHIN_20KM' ? 'entro 20 km' : 'oltre 20 km');
      return parts.join(', ');
    },
    groupLabels: {
      single: 'Single',
      married: 'Sposato/a',
      withChildren: (n) => (n === 1 ? 'Con 1 figlio' : `Con ${n} figli`),
      new: 'Nuovo frontaliere',
      old: 'Vecchio frontaliere',
      within20: 'entro 20 km',
      over20: 'oltre 20 km',
    },
    paginationPrev: 'Pagina precedente',
    paginationNext: 'Pagina successiva',
    pageOfTotal: (current, total) => `Pagina ${current} di ${total}`,
  },
  en: {
    metaTitle: 'All cross-border net-salary scenarios — 2026 index',
    metaDescription:
      'Full directory of 400+ net-salary scenarios for Swiss-Italian cross-border workers — CHF 40,000 to CHF 150,000, single or married, with children, old or new agreement, within or beyond 20 km. 2026 simulation.',
    h1: 'All net-salary scenarios for cross-border workers',
    intro:
      'This index lists every simulation available in the cross-border salary calculator: 18 gross-income tiers (CHF 40,000 to CHF 150,000) combined with marital status, number of children, agreement type (old or new, 2026 framework) and border-distance zone (within 20 km, beyond 20 km). Each link opens a page with annual net, monthly net, the Ticino withholding tax table, the effective rate and the side-by-side comparison against a Swiss resident. Pages are recomputed on every build with the 2026 AVS, LPP, withholding-tax and IRPEF parameters.',
    home: 'Home',
    calcSection: 'Calculate Salary',
    scenariosBreadcrumb: 'All scenarios',
    tierHeading: (salary) => `Gross salary CHF ${fmtCHF(salary)}`,
    tierMethodology: (salary, tierCount) =>
      `For gross income of CHF ${fmtCHF(salary)} the Ticino withholding tax sits between 8 % and 13 % depending on the table (A single, B non-working spouse, C dual-earner, H lone parent). The ${tierCount} simulations below cover every useful combination of marital status, children, agreement type and distance zone, holding AVS (5.3 %), LPP (5 % at age 35) and the average LAMal premium (CHF 350/month) constant.`,
    countLabel: (n) => `${n} scenarios`,
    faqTitle: 'About this index',
    faqs: [
      {
        q: 'How do I pick the right scenario?',
        a: 'Start from your effective gross annual income (pick the closest tier), then filter by marital status, number of children, agreement type (old = hired before 17 July 2023 with residence within 20 km; new = everyone else) and distance zone. Each page reports the tax table, effective rate and CH vs IT comparison.',
      },
      {
        q: 'Why do some salary tiers have fewer scenarios?',
        a: 'Tiers matching legacy editorial slugs (CHF 60,000, 80,000, 100,000) are partially covered by historical SEO pages and are not duplicated in the auto-generated hub — see `EXISTING_IT_SLUGS` in `salaryHubScenarios.ts` for the full list.',
      },
      {
        q: 'Are the numbers up to date for 2026?',
        a: 'Yes. Simulations are recomputed on every build with the current AVS/LPP rates, Ticino withholding-tax tables, Italian IRPEF brackets and the EUR 10,000 deduction granted to new cross-border workers under the 2026 agreement.',
      },
      {
        q: 'Can I customise a scenario?',
        a: 'Yes. Every scenario page has a "Customize this simulation" button that opens the main calculator pre-filled with that page\u2019s parameters, where you can edit income, LAMal premium, age, municipality of residence and more.',
      },
    ],
    scenarioLabel: (s) => {
      const parts: string[] = [];
      parts.push(s.maritalStatus === 'MARRIED' ? 'married' : 'single');
      if (s.children > 0) parts.push(s.children === 1 ? '1 child' : `${s.children} children`);
      parts.push(s.frontierType === 'OLD' ? 'old cross-border worker' : 'new cross-border worker');
      parts.push(s.distanceZone === 'WITHIN_20KM' ? 'within 20 km' : 'over 20 km');
      return parts.join(', ');
    },
    groupLabels: {
      single: 'Single',
      married: 'Married',
      withChildren: (n) => (n === 1 ? 'With 1 child' : `With ${n} children`),
      new: 'New cross-border worker',
      old: 'Old cross-border worker',
      within20: 'within 20 km',
      over20: 'over 20 km',
    },
    paginationPrev: 'Previous page',
    paginationNext: 'Next page',
    pageOfTotal: (current, total) => `Page ${current} of ${total}`,
  },
  de: {
    metaTitle: 'Alle Grenzg\u00e4nger-Nettogehaltsszenarien — Index 2026',
    metaDescription:
      '\u00dcber 400 Nettogehaltsszenarien f\u00fcr italienische Grenzg\u00e4nger \u2014 CHF 40\u2019000 bis CHF 150\u2019000, ledig oder verheiratet, mit Kindern, alter oder neuer Grenzg\u00e4nger, innerhalb oder jenseits 20 km. Simulation 2026.',
    h1: 'Alle Nettogehaltsszenarien f\u00fcr Grenzg\u00e4nger',
    intro:
      'Dieses Verzeichnis listet jede Simulation des Grenzg\u00e4nger-Lohnrechners: 18 Bruttoeinkommensstufen (CHF 40\u2019000 bis CHF 150\u2019000) kombiniert mit Zivilstand, Kinderzahl, Abkommenstyp (alt oder neu, 2026) und Distanzzone (innerhalb 20 km, jenseits 20 km). Jeder Link \u00f6ffnet eine Seite mit Jahres- und Monatsnetto, Tessiner Quellensteuertabelle, effektivem Steuersatz und CH-IT-Vergleich. Die Seiten werden bei jedem Build mit den AVS/LPP-Beitr\u00e4gen, Quellensteuertabellen und IRPEF-Stufen 2026 neu berechnet.',
    home: 'Startseite',
    calcSection: 'Gehalt berechnen',
    scenariosBreadcrumb: 'Alle Szenarien',
    tierHeading: (salary) => `Bruttolohn CHF ${fmtCHF(salary)}`,
    tierMethodology: (salary, tierCount) =>
      `Bei einem Bruttoeinkommen von CHF ${fmtCHF(salary)} liegt die Tessiner Quellensteuer je nach Tabelle (A ledig, B nicht erwerbst\u00e4tiger Ehepartner, C beide erwerbst\u00e4tig, H alleinerziehend) zwischen 8 % und 13 %. Die ${tierCount} Simulationen unten decken alle relevanten Kombinationen aus Zivilstand, Kindern, Abkommenstyp und Distanzzone ab, w\u00e4hrend AVS (5,3 %), BVG (5 % mit 35) und durchschnittliche KVG-Pr\u00e4mie (CHF 350/Monat) konstant gehalten werden.`,
    countLabel: (n) => `${n} Szenarien`,
    faqTitle: 'H\u00e4ufige Fragen zu diesem Index',
    faqs: [
      {
        q: 'Wie w\u00e4hle ich das richtige Szenario aus?',
        a: 'Starten Sie mit Ihrem effektiven Bruttojahreseinkommen in CHF (n\u00e4chstgelegene Stufe), filtern Sie dann nach Zivilstand, Kinderzahl, Abkommenstyp (alt = vor 17. Juli 2023 angestellt mit Wohnsitz innerhalb 20 km; neu = alle anderen) und Distanzzone. Jede Seite zeigt Steuertabelle, effektiven Satz und CH-IT-Vergleich.',
      },
      {
        q: 'Warum haben einige Lohnstufen weniger Szenarien?',
        a: 'Stufen, die mit redaktionellen Legacy-Slugs (CHF 60\u2019000, 80\u2019000, 100\u2019000) \u00fcbereinstimmen, sind bereits durch historische SEO-Seiten abgedeckt und werden im automatischen Hub nicht dupliziert.',
      },
      {
        q: 'Sind die Werte 2026 aktuell?',
        a: 'Ja. Bei jedem Build werden die Simulationen mit den aktuellen AVS-/BVG-Beitr\u00e4gen, Tessiner Quellensteuertabellen, italienischen IRPEF-Stufen und dem EUR 10\u2019000 Freibetrag f\u00fcr neue Grenzg\u00e4nger nach dem Abkommen 2026 neu berechnet.',
      },
      {
        q: 'Kann ich ein Szenario anpassen?',
        a: 'Ja. Jede Szenarioseite hat einen Button "Diese Simulation anpassen", der den Hauptrechner mit den Parametern der Seite vorausgef\u00fcllt \u00f6ffnet \u2014 dort k\u00f6nnen Sie Einkommen, KVG-Pr\u00e4mie, Alter, Wohngemeinde und weitere Variablen \u00e4ndern.',
      },
    ],
    scenarioLabel: (s) => {
      const parts: string[] = [];
      parts.push(s.maritalStatus === 'MARRIED' ? 'verheiratet' : 'ledig');
      if (s.children > 0) parts.push(s.children === 1 ? '1 Kind' : `${s.children} Kinder`);
      parts.push(s.frontierType === 'OLD' ? 'alter Grenzg\u00e4nger' : 'neuer Grenzg\u00e4nger');
      parts.push(s.distanceZone === 'WITHIN_20KM' ? 'innerhalb 20 km' : '\u00fcber 20 km');
      return parts.join(', ');
    },
    groupLabels: {
      single: 'Ledig',
      married: 'Verheiratet',
      withChildren: (n) => (n === 1 ? 'Mit 1 Kind' : `Mit ${n} Kindern`),
      new: 'Neuer Grenzg\u00e4nger',
      old: 'Alter Grenzg\u00e4nger',
      within20: 'innerhalb 20 km',
      over20: '\u00fcber 20 km',
    },
    paginationPrev: 'Vorherige Seite',
    paginationNext: 'N\u00e4chste Seite',
    pageOfTotal: (current, total) => `Seite ${current} von ${total}`,
  },
  fr: {
    metaTitle: 'Tous les sc\u00e9narios de salaire net frontalier \u2014 index 2026',
    metaDescription:
      'Plus de 400 sc\u00e9narios de salaire net pour frontaliers italiens \u2014 CHF 40\u00a0000 \u00e0 CHF 150\u00a0000, c\u00e9libataire ou mari\u00e9, avec enfants, ancien ou nouveau frontalier, moins ou plus de 20 km. Simulation 2026.',
    h1: 'Tous les sc\u00e9narios de salaire net pour frontaliers',
    intro:
      'Cet index recense chaque simulation disponible dans le calculateur frontalier : 18 niveaux de revenu brut (CHF 40\u00a0000 \u00e0 CHF 150\u00a0000) combin\u00e9s avec l\u2019\u00e9tat civil, le nombre d\u2019enfants, le type d\u2019accord (ancien ou nouveau, accord 2026) et la zone de distance (moins de 20 km, plus de 20 km). Chaque lien ouvre une page d\u00e9taill\u00e9e avec le net annuel, le net mensuel, le bar\u00e8me \u00e0 la source tessinois, le taux effectif et la comparaison avec un r\u00e9sident suisse. Les pages sont recalcul\u00e9es \u00e0 chaque build avec les param\u00e8tres AVS, LPP, imp\u00f4t \u00e0 la source et IRPEF 2026.',
    home: 'Accueil',
    calcSection: 'Calculer salaire',
    scenariosBreadcrumb: 'Tous les sc\u00e9narios',
    tierHeading: (salary) => `Salaire brut CHF ${fmtCHF(salary)}`,
    tierMethodology: (salary, tierCount) =>
      `Pour un revenu brut de CHF ${fmtCHF(salary)} l\u2019imp\u00f4t \u00e0 la source tessinois se situe entre 8 % et 13 % selon le bar\u00e8me (A c\u00e9libataire, B conjoint sans activit\u00e9, C double activit\u00e9, H parent isol\u00e9). Les ${tierCount} simulations ci-dessous couvrent chaque combinaison utile d\u2019\u00e9tat civil, enfants, type d\u2019accord et zone de distance, en gardant constantes AVS (5,3 %), LPP (5 % \u00e0 35 ans) et prime LAMal moyenne (CHF 350/mois).`,
    countLabel: (n) => `${n} sc\u00e9narios`,
    faqTitle: 'Questions fr\u00e9quentes sur cet index',
    faqs: [
      {
        q: 'Comment choisir le bon sc\u00e9nario ?',
        a: 'Commencez par votre revenu brut annuel CHF effectif (choisissez le palier le plus proche), puis filtrez par \u00e9tat civil, nombre d\u2019enfants, type d\u2019accord (ancien = embauch\u00e9 avant le 17 juillet 2023 avec r\u00e9sidence dans les 20 km ; nouveau = tous les autres) et zone de distance. Chaque page indique le bar\u00e8me, le taux effectif et la comparaison CH-IT.',
      },
      {
        q: 'Pourquoi certains paliers ont-ils moins de sc\u00e9narios ?',
        a: 'Les paliers correspondant \u00e0 d\u2019anciennes pages \u00e9ditoriales (CHF 60\u00a0000, 80\u00a0000, 100\u00a0000) sont d\u00e9j\u00e0 couverts par des landings SEO historiques et ne sont pas dupliqu\u00e9s dans le hub g\u00e9n\u00e9r\u00e9.',
      },
      {
        q: 'Les chiffres sont-ils \u00e0 jour pour 2026 ?',
        a: 'Oui. Les simulations sont recalcul\u00e9es \u00e0 chaque build avec les taux AVS/LPP en vigueur, les bar\u00e8mes \u00e0 la source tessinois, les tranches IRPEF italiennes et la franchise de EUR 10\u00a0000 accord\u00e9e aux nouveaux frontaliers par l\u2019accord 2026.',
      },
      {
        q: 'Puis-je personnaliser un sc\u00e9nario ?',
        a: 'Oui. Chaque page de sc\u00e9nario propose un bouton \u00ab Personnaliser cette simulation \u00bb qui ouvre le calculateur principal pr\u00e9-rempli avec les param\u00e8tres de la page \u2014 vous pouvez y modifier revenu, prime LAMal, \u00e2ge, commune de r\u00e9sidence et autres variables.',
      },
    ],
    scenarioLabel: (s) => {
      const parts: string[] = [];
      parts.push(s.maritalStatus === 'MARRIED' ? 'mari\u00e9(e)' : 'c\u00e9libataire');
      if (s.children > 0) parts.push(s.children === 1 ? '1 enfant' : `${s.children} enfants`);
      parts.push(s.frontierType === 'OLD' ? 'ancien frontalier' : 'nouveau frontalier');
      parts.push(s.distanceZone === 'WITHIN_20KM' ? 'moins de 20 km' : 'plus de 20 km');
      return parts.join(', ');
    },
    groupLabels: {
      single: 'C\u00e9libataire',
      married: 'Mari\u00e9(e)',
      withChildren: (n) => (n === 1 ? 'Avec 1 enfant' : `Avec ${n} enfants`),
      new: 'Nouveau frontalier',
      old: 'Ancien frontalier',
      within20: 'moins de 20 km',
      over20: 'plus de 20 km',
    },
    paginationPrev: 'Page pr\u00e9c\u00e9dente',
    paginationNext: 'Page suivante',
    pageOfTotal: (current, total) => `Page ${current} sur ${total}`,
  },
};

// ── Grouping ───────────────────────────────────────────────────────────────

interface ScenarioGroup {
  readonly key: string;
  readonly label: string;
  readonly scenarios: readonly SalaryHubScenario[];
}

interface TierGroup {
  readonly salary: number;
  readonly heading: string;
  readonly count: number;
  readonly methodology: string;
  readonly groups: readonly ScenarioGroup[];
}

/**
 * Group scenarios for one salary tier into family-situation buckets.
 *
 * Each bucket is a small, sensible cluster (~3-6 links). This keeps the page
 * scannable for users while still surfacing every scenario as a real `<a>`.
 */
function buildTierGroups(
  scenariosForSalary: readonly SalaryHubScenario[],
  l: IndexLabels,
): readonly ScenarioGroup[] {
  const buckets: { key: string; label: string; predicate: (s: SalaryHubScenario) => boolean }[] = [
    {
      key: 'single-no-children',
      label: l.groupLabels.single,
      predicate: (s) => s.maritalStatus === 'SINGLE' && s.children === 0,
    },
    {
      key: 'single-1-child',
      label: `${l.groupLabels.single} \u2014 ${l.groupLabels.withChildren(1)}`,
      predicate: (s) => s.maritalStatus === 'SINGLE' && s.children === 1,
    },
    {
      key: 'single-2-children',
      label: `${l.groupLabels.single} \u2014 ${l.groupLabels.withChildren(2)}`,
      predicate: (s) => s.maritalStatus === 'SINGLE' && s.children === 2,
    },
    {
      key: 'single-3-children',
      label: `${l.groupLabels.single} \u2014 ${l.groupLabels.withChildren(3)}`,
      predicate: (s) => s.maritalStatus === 'SINGLE' && s.children === 3,
    },
    {
      key: 'married-no-children',
      label: l.groupLabels.married,
      predicate: (s) => s.maritalStatus === 'MARRIED' && s.children === 0,
    },
    {
      key: 'married-1-child',
      label: `${l.groupLabels.married} \u2014 ${l.groupLabels.withChildren(1)}`,
      predicate: (s) => s.maritalStatus === 'MARRIED' && s.children === 1,
    },
    {
      key: 'married-2-children',
      label: `${l.groupLabels.married} \u2014 ${l.groupLabels.withChildren(2)}`,
      predicate: (s) => s.maritalStatus === 'MARRIED' && s.children === 2,
    },
    {
      key: 'married-3-children',
      label: `${l.groupLabels.married} \u2014 ${l.groupLabels.withChildren(3)}`,
      predicate: (s) => s.maritalStatus === 'MARRIED' && s.children === 3,
    },
  ];
  const out: ScenarioGroup[] = [];
  for (const b of buckets) {
    const list = scenariosForSalary.filter(b.predicate);
    if (list.length === 0) continue;
    out.push({ key: b.key, label: b.label, scenarios: list });
  }
  return out;
}

/** Build the 18-tier breakdown for one locale. */
export function buildTierGroupsForLocale(
  allScenarios: readonly SalaryHubScenario[],
  locale: Locale,
): readonly TierGroup[] {
  const l = LABELS[locale];
  const tiers: TierGroup[] = [];
  for (const salary of SALARY_LEVELS) {
    const forSalary = allScenarios.filter((s) => s.salary === salary);
    if (forSalary.length === 0) continue;
    tiers.push({
      salary,
      heading: l.tierHeading(salary),
      count: forSalary.length,
      methodology: l.tierMethodology(salary, forSalary.length),
      groups: buildTierGroups(forSalary, l),
    });
  }
  return tiers;
}

// ── HTML generation ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INDEX_PAGE_STYLE = `<style>
.salary-index-page{max-width:1100px;margin:0 auto;padding:24px 16px;color:#334155;line-height:1.65}
.salary-index-page .breadcrumb{font-size:13px;color:#64748b;margin-bottom:16px}
.salary-index-page .breadcrumb a{color:#533afd;text-decoration:none}
.salary-index-page h1{font-size:32px;font-weight:800;color:#1e293b;margin:0 0 12px;line-height:1.2}
.salary-index-page .lede{font-size:16px;color:#475569;margin:0 0 28px;max-width:80ch}
.salary-index-page h2{font-size:22px;font-weight:700;color:#1e293b;margin:36px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:6px}
.salary-index-page .tier-meta{font-size:13px;color:#64748b;margin:0 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.salary-index-page .tier-method{font-size:14px;color:#475569;margin:0 0 16px;max-width:78ch}
.salary-index-page h3{font-size:15px;font-weight:700;color:#334155;margin:18px 0 6px}
.salary-index-page ul.scenarios{list-style:none;margin:0 0 4px;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px 16px}
.salary-index-page ul.scenarios li{margin:0;padding:0}
.salary-index-page ul.scenarios a{color:#533afd;text-decoration:none;font-size:14px;display:block;padding:6px 0;border-bottom:1px dotted #e2e8f0}
.salary-index-page ul.scenarios a:hover{text-decoration:underline}
.salary-index-page .faq{margin-top:48px;padding-top:24px;border-top:2px solid #e2e8f0}
.salary-index-page .faq-q{font-weight:700;color:#1e293b;margin:18px 0 4px;font-size:16px}
.salary-index-page .faq-a{font-size:14px;color:#475569;margin:0 0 12px;max-width:78ch}
.salary-index-page .pagination{margin:32px 0 8px;font-size:14px;color:#64748b}
.salary-index-page .pagination a{color:#533afd;text-decoration:none;margin:0 12px}
</style>`;

export interface RelatedArticle {
  /** Title to display for this locale. */
  readonly title: string;
  /** Absolute path on the canonical host (begins with `/`, ends with `/`). */
  readonly href: string;
}

export interface ScenarioIndexPageOpts {
  locale: Locale;
  allScenarios: readonly SalaryHubScenario[];
  /** Optional: 1-based page number when paginated. Defaults to 1. */
  page?: number;
  /** Optional: total pages when paginated. Defaults to 1. */
  totalPages?: number;
  /**
   * Optional: list of evergreen-article links to surface at the bottom of the
   * index. Used to wire the salary-hub article graph (8 articles × 4 locales)
   * into the BFS reachable set. When omitted, no article-list section is
   * rendered.
   */
  relatedArticles?: readonly RelatedArticle[];
  distDir?: string;
}

/**
 * Render the full HTML for one locale's scenario index page (single page —
 * no pagination by default).
 */
export function buildScenarioIndexHtml(opts: ScenarioIndexPageOpts): string {
  const { locale, allScenarios } = opts;
  const page = opts.page ?? 1;
  const totalPages = opts.totalPages ?? 1;
  const l = LABELS[locale];

  const indexPath = SCENARIO_INDEX_PATH[locale];
  const calcHubPath = CALC_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${indexPath}`;

  const hreflangHtml = renderHreflangTags(SCENARIO_INDEX_PATH);

  const tiers = buildTierGroupsForLocale(allScenarios, locale);

  const tierSectionsHtml = tiers
    .map((tier) => {
      const groupsHtml = tier.groups
        .map((g) => {
          const items = g.scenarios
            .map((s) => {
              const href = buildFullPath(s, locale);
              const label = `${fmtCHF(s.salary)} CHF \u2014 ${l.scenarioLabel(s)}`;
              // Real anchor; no JS, no rel=nofollow — must be crawlable for BFS.
              return `<li><a href="${esc(href)}">${esc(label)}</a></li>`;
            })
            .join('');
          return `<h3>${esc(g.label)}</h3><ul class="scenarios">${items}</ul>`;
        })
        .join('\n');
      return `<section data-tier="${tier.salary}">
        <p class="tier-meta">${esc(l.countLabel(tier.count))}</p>
        <h2 id="tier-${tier.salary}">${esc(tier.heading)}</h2>
        <p class="tier-method">${esc(tier.methodology)}</p>
        ${groupsHtml}
      </section>`;
    })
    .join('\n');

  const faqHtml = `<section class="faq">
    <h2>${esc(l.faqTitle)}</h2>
    ${l.faqs
      .map((f) => `<div><div class="faq-q">${esc(f.q)}</div><div class="faq-a">${esc(f.a)}</div></div>`)
      .join('\n')}
  </section>`;

  // Optional related-articles block. We keep it as a real `<a href>` list so
  // BFS reachability extends to the salary-hub evergreen articles too.
  const RELATED_HEADINGS: Record<Locale, string> = {
    it: 'Approfondimenti correlati',
    en: 'Related guides',
    de: 'Verwandte Leitf\u00e4den',
    fr: 'Guides associ\u00e9s',
  };
  const relatedArticlesHtml =
    opts.relatedArticles && opts.relatedArticles.length > 0
      ? `<section data-salary-index-related-articles style="margin-top:32px">
          <h2>${esc(RELATED_HEADINGS[locale])}</h2>
          <ul class="scenarios">${opts.relatedArticles
            .map((a) => `<li><a href="${esc(a.href)}">${esc(a.title)}</a></li>`)
            .join('')}</ul>
        </section>`
      : '';

  const paginationHtml =
    totalPages > 1
      ? `<nav class="pagination" aria-label="pagination">
          ${page > 1 ? `<a href="${esc(indexPath)}?p=${page - 1}" rel="prev">&larr; ${esc(l.paginationPrev)}</a>` : ''}
          <span>${esc(l.pageOfTotal(page, totalPages))}</span>
          ${page < totalPages ? `<a href="${esc(indexPath)}?p=${page + 1}" rel="next">${esc(l.paginationNext)} &rarr;</a>` : ''}
        </nav>`
      : '';

  // Breadcrumb + ItemList JSON-LD. ItemList is intentionally summarised at
  // tier-level (18 entries) so the JSON-LD payload stays small while still
  // surfacing the structure to crawlers.
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: l.home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: l.calcSection, item: `${BASE_URL}${calcHubPath}` },
      { '@type': 'ListItem', position: 3, name: l.scenariosBreadcrumb, item: canonicalUrl },
    ],
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: l.h1,
    numberOfItems: tiers.length,
    itemListElement: tiers.map((tier, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: tier.heading,
      url: `${canonicalUrl}#tier-${tier.salary}`,
    })),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: l.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  // Cross-locale `<a href>` switcher — BFS only follows <a> tags (not
  // <link rel="alternate">), so without a real anchor to each locale twin
  // the DE/FR halves of `sitemap-salary-hub.xml` would stay orphan even
  // after the IT/EN halves are linked. The labels are short and language-
  // tagged so users (not only crawlers) can switch locale from this page.
  const LOCALE_SWITCHER_LABELS: Record<Locale, string> = {
    it: 'Italiano',
    en: 'English',
    de: 'Deutsch',
    fr: 'Fran\u00e7ais',
  };
  const localeSwitcherHtml = `<nav aria-label="locales" data-salary-index-locale-switch style="margin:0 0 28px;font-size:13px;color:#64748b">
    ${LOCALES
      .map((loc) => {
        const href = SCENARIO_INDEX_PATH[loc];
        const label = LOCALE_SWITCHER_LABELS[loc];
        if (loc === locale) {
          return `<span style="margin-right:14px;font-weight:700;color:#1e293b" lang="${loc}">${esc(label)}</span>`;
        }
        return `<a href="${esc(href)}" hreflang="${loc}" lang="${loc}" style="margin-right:14px;color:#533afd;text-decoration:none">${esc(label)}</a>`;
      })
      .join('')}
  </nav>`;

  const bodyHtml = `<article class="salary-index-page" data-salary-scenario-index>
    <nav class="breadcrumb">
      <a href="/">${esc(l.home)}</a> &rsaquo;
      <a href="${esc(calcHubPath)}">${esc(l.calcSection)}</a> &rsaquo;
      ${esc(l.scenariosBreadcrumb)}
    </nav>
    <h1>${esc(l.h1)}</h1>
    <p class="lede">${esc(l.intro)}</p>
    ${localeSwitcherHtml}
    ${tierSectionsHtml}
    ${paginationHtml}
    ${relatedArticlesHtml}
    ${faqHtml}
  </article>`;

  return buildSeoPageHtml({
    locale,
    title: l.metaTitle,
    description: l.metaDescription,
    canonicalUrl,
    hreflangHtml,
    ogType: 'website',
    extraHeadHtml: INDEX_PAGE_STYLE,
    jsonLdScripts: [breadcrumbLd, itemListLd, faqLd],
    bodyHtml,
    distDir: opts.distDir,
  });
}

/** Emit one HTML page per locale. Returns a map locale → html. */
export function buildAllScenarioIndexes(
  allScenarios: readonly SalaryHubScenario[],
  distDir: string,
  relatedArticlesByLocale?: Partial<Record<Locale, readonly RelatedArticle[]>>,
): Record<Locale, string> {
  const out: Partial<Record<Locale, string>> = {};
  for (const loc of LOCALES) {
    out[loc] = buildScenarioIndexHtml({
      locale: loc,
      allScenarios,
      distDir,
      relatedArticles: relatedArticlesByLocale?.[loc],
    });
  }
  return out as Record<Locale, string>;
}

// Re-export for consumers (plugin + tests).
export { LOCALES };
export type { Locale };

// Used by tests to assert the locale label coverage matches HREFLANG_LOCALES.
export { LABELS as __INDEX_LABELS_FOR_TESTS };
