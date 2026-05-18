/**
 * Render the mobile-first body for every `/calcola-stipendio/*` SEO landing
 * (and its EN/DE/FR siblings under `/calculate-salary`, `/gehalt-berechnen`,
 * `/calculer-salaire`).
 *
 * Structure follows the SEO-landing UI/UX template in CLAUDE.md rule 17:
 *
 *   breadcrumb · eyebrow · H1 · lede ≤120c · stat tiles ·
 *   "consiglio" banner · primary CTA (above mobile fold) ·
 *   comparative table · FAQ accordion · long prose (bottom)
 *
 * Data shape per scenario × locale lives in `SCENARIOS` (hub pages) or is
 * generated parametrically for the salary-tier and net-comparison families.
 * Colors bind to OKLCH semantic tokens (`var(--color-*)`); fonts inherit
 * from `body` so the page matches the rest of the site without re-loading.
 */

import {
  H1_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  CTA_PRIMARY_STYLE,
  STAT_TILE_WARNING,
  TABLE_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  LINK_ACCENT_STYLE,
  SMALL_HEADING_STYLE,
  esc,
  renderBreadcrumb,
  renderStatGrid,
  type StatTileTone,
} from './seoContentTokens';

export type SalaryLocale = 'it' | 'en' | 'de' | 'fr';

export interface SalaryTile {
  readonly label: string;
  readonly value: string;
  readonly tone?: StatTileTone;
}

export interface SalaryTableRow {
  readonly cells: ReadonlyArray<string>;
  readonly emphasized?: boolean;
}

export interface SalaryTable {
  readonly caption: string;
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<SalaryTableRow>;
  readonly footnote?: string;
}

export interface SalaryFaqItem {
  readonly q: string;
  readonly a: string;
}

export interface SalaryLandingData {
  readonly eyebrow: string;
  readonly tagline: string;
  readonly tiles: ReadonlyArray<SalaryTile>;
  readonly advice?: string;
  readonly ctaPrimary: { label: string; href: string };
  readonly ctaSecondary?: { label: string; href: string };
  readonly table?: SalaryTable;
  readonly faqs?: ReadonlyArray<SalaryFaqItem>;
}

// ── Locale-aware label packs ────────────────────────────────────────────────

interface LocalePack {
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly hubHref: string;
  readonly adviceLabel: string;
  readonly faqsLabel: string;
  readonly navLabel: string;
  readonly ctaPrimary: string;
  readonly ctaSecondary: string;
  readonly simulatorHref: string;
  readonly whatIfHref: string;
}

const LOCALE_PACKS: Record<SalaryLocale, LocalePack> = {
  it: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Calcola stipendio',
    hubHref: '/calcola-stipendio/',
    adviceLabel: 'Consiglio',
    faqsLabel: 'Domande frequenti',
    navLabel: 'Sito',
    ctaPrimary: 'Calcola il tuo netto',
    ctaSecondary: 'Apri il simulatore what-if',
    simulatorHref: '/calcola-stipendio/',
    whatIfHref: '/calcola-stipendio/cosa-cambia-se/',
  },
  en: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Calculate salary',
    hubHref: '/en/calculate-salary/',
    adviceLabel: 'Insight',
    faqsLabel: 'Frequently asked',
    navLabel: 'Site',
    ctaPrimary: 'Calculate your net',
    ctaSecondary: 'Open the what-if simulator',
    simulatorHref: '/en/calculate-salary/',
    whatIfHref: '/en/calculate-salary/what-if/',
  },
  de: {
    breadcrumbHome: 'Start',
    breadcrumbHub: 'Gehalt berechnen',
    hubHref: '/de/gehalt-berechnen/',
    adviceLabel: 'Hinweis',
    faqsLabel: 'Häufige Fragen',
    navLabel: 'Site',
    ctaPrimary: 'Netto berechnen',
    ctaSecondary: 'Was-wäre-wenn-Simulator öffnen',
    simulatorHref: '/de/gehalt-berechnen/',
    whatIfHref: '/de/gehalt-berechnen/was-waere-wenn/',
  },
  fr: {
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Calculer salaire',
    hubHref: '/fr/calculer-salaire/',
    adviceLabel: 'Conseil',
    faqsLabel: 'Questions fréquentes',
    navLabel: 'Site',
    ctaPrimary: 'Calculer votre net',
    ctaSecondary: 'Ouvrir le simulateur si',
    simulatorHref: '/fr/calculer-salaire/',
    whatIfHref: '/fr/calculer-salaire/et-si/',
  },
};

// ── Hub scenarios (6) — hand-authored per locale ────────────────────────────
//
// Each hub has a stable internal `key` (matching the IT slug) and one entry
// per supported locale. The locale entries share structure but differ in
// language. Numbers (CHF, EUR, %) are kept identical across locales because
// they describe the same fiscal facts.

type HubKey =
  | 'nuovi-frontalieri-oltre-20-km'
  | 'simula-busta-paga'
  | 'cosa-cambia-se'
  | 'confronta-stipendi'
  | 'quanto-guadagneresti-in-svizzera'
  | 'confronta-retribuzione-ral'
  | 'simula-cambio-residenza'
  | 'stima-bonus-frontaliere'
  | 'verifica-congedo-parentale';

// Note: EN/DE/FR keys are kept for legacy `nuovi-frontalieri-oltre-20-km`,
// `simula-busta-paga`, `cosa-cambia-se`, `quiz-stipendio` (now
// `quanto-guadagneresti-in-svizzera`), `confronta-stipendi` and
// `confronta-retribuzione-ral` — currently unreachable via HUB_PATH_TO_KEY
// but preserved for future expansion. New hubs (`simula-cambio-residenza`,
// `stima-bonus-frontaliere`, `verifica-congedo-parentale`) are IT-only.
const HUB_SCENARIOS: Record<HubKey, Partial<Record<SalaryLocale, SalaryLandingData>>> = {
  'nuovi-frontalieri-oltre-20-km': {
    it: {
      eyebrow: 'Nuovo Accordo 2024 · Oltre 20 km',
      tagline: 'Tassazione concorrente: la Svizzera trattiene il 100%, poi l\'Italia ricalcola con credito d\'imposta.',
      tiles: [
        { label: 'Imposta alla fonte CH', value: '100%', tone: 'accent' },
        { label: 'Quota ai comuni IT', value: '0%', tone: 'danger' },
        { label: 'Carico fiscale extra', value: '+2-4k EUR/anno', tone: 'warning' },
        { label: 'Da quando', value: 'dal 17.07.2023', tone: 'neutral' },
      ],
      advice: 'Su una RAL di CHF 70.000, la residenza oltre 20 km (es. Milano) costa circa 3.000 EUR/anno in più rispetto a una entro 20 km (es. Como), a parità di stipendio.',
      ctaPrimary: { label: 'Calcola il tuo netto', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronta scenari entro vs oltre 20 km', href: '/calcola-stipendio/cosa-cambia-se/' },
      table: {
        caption: 'Differenza netto annuo: entro 20 km vs oltre 20 km (A0N, Ticino)',
        headers: ['RAL (CHF)', 'Netto entro 20 km', 'Netto oltre 20 km', 'Δ EUR/anno'],
        rows: [
          { cells: ['60.000', '~46.000 EUR', '~44.500 EUR', '-1.500'] },
          { cells: ['80.000', '~58.000 EUR', '~55.000 EUR', '-3.000'], emphasized: true },
          { cells: ['100.000', '~70.000 EUR', '~66.000 EUR', '-4.200'] },
        ],
        footnote: 'Stime indicative basate su tabelle Canton Ticino 2026 + IRPEF con franchigia 10.000 EUR.',
      },
      faqs: [
        { q: 'Chi rientra tra i nuovi frontalieri oltre 20 km?', a: 'Chi ha iniziato il rapporto di lavoro transfrontaliero dal 17 luglio 2023 in poi e risiede in un comune italiano oltre 20 km dalla frontiera svizzera.' },
        { q: 'Cosa cambia rispetto a chi vive entro 20 km?', a: 'Per i nuovi frontalieri oltre 20 km la Svizzera trattiene il 100% dell\'imposta alla fonte. Entro 20 km la Svizzera trattiene l\'80% e l\'Italia tassa il reddito con credito per le imposte già pagate.' },
        { q: 'Questa pagina sostituisce la consulenza fiscale?', a: 'No. Aiuta a capire scenari e ordini di grandezza, ma per casi particolari resta consigliabile una verifica con un professionista fiscale specializzato in frontalieri.' },
      ],
    },
    en: {
      eyebrow: 'New Agreement 2024 · Over 20 km',
      tagline: 'Concurrent taxation: Switzerland withholds 100%, then Italy recalculates with foreign-tax credit.',
      tiles: [
        { label: 'Swiss withholding', value: '100%', tone: 'accent' },
        { label: 'Italian commune share', value: '0%', tone: 'danger' },
        { label: 'Extra tax burden', value: '+2-4k EUR/year', tone: 'warning' },
        { label: 'Effective since', value: 'from 17 Jul 2023', tone: 'neutral' },
      ],
      advice: 'On a CHF 70,000 gross salary, residing beyond 20 km (e.g. Milan) costs roughly EUR 3,000/year more than residing within 20 km (e.g. Como), at the same gross pay.',
      ctaPrimary: { label: 'Calculate your net', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'Compare within vs over 20 km scenarios', href: '/en/calculate-salary/what-if/' },
      table: {
        caption: 'Annual net difference: within 20 km vs over 20 km (A0N, Ticino)',
        headers: ['Gross (CHF)', 'Net within 20 km', 'Net over 20 km', 'Δ EUR/year'],
        rows: [
          { cells: ['60,000', '~46,000 EUR', '~44,500 EUR', '-1,500'] },
          { cells: ['80,000', '~58,000 EUR', '~55,000 EUR', '-3,000'], emphasized: true },
          { cells: ['100,000', '~70,000 EUR', '~66,000 EUR', '-4,200'] },
        ],
        footnote: 'Indicative estimates based on Canton Ticino 2026 tables + Italian IRPEF with EUR 10,000 allowance.',
      },
      faqs: [
        { q: 'Who qualifies as a new cross-border worker over 20 km?', a: 'Anyone who began cross-border employment on or after 17 July 2023 and lives in an Italian municipality more than 20 km from the Swiss border.' },
        { q: 'What changes vs living within 20 km?', a: 'For new workers over 20 km, Switzerland withholds 100% of source tax. Within 20 km, Switzerland withholds 80% and Italy taxes the income with credit for taxes already paid.' },
        { q: 'Does this page replace tax advice?', a: 'No. It helps you understand scenarios and orders of magnitude. For specific cases, consult a tax professional specialised in cross-border workers.' },
      ],
    },
    de: {
      eyebrow: 'Neues Abkommen 2024 · Über 20 km',
      tagline: 'Konkurrierende Besteuerung: Die Schweiz behält 100 % ein, dann rechnet Italien mit Anrechnung.',
      tiles: [
        { label: 'Schweizer Quellensteuer', value: '100%', tone: 'accent' },
        { label: 'Anteil an IT-Gemeinden', value: '0%', tone: 'danger' },
        { label: 'Zusätzliche Steuerlast', value: '+2-4k EUR/Jahr', tone: 'warning' },
        { label: 'Gilt seit', value: 'ab 17.07.2023', tone: 'neutral' },
      ],
      advice: 'Bei einem Bruttogehalt von CHF 70.000 kostet der Wohnsitz über 20 km (z. B. Mailand) rund EUR 3.000/Jahr mehr als ein Wohnsitz bis 20 km (z. B. Como).',
      ctaPrimary: { label: 'Netto berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Szenarien bis vs. über 20 km vergleichen', href: '/de/gehalt-berechnen/was-waere-wenn/' },
      table: {
        caption: 'Nettounterschied pro Jahr: bis 20 km vs. über 20 km (A0N, Tessin)',
        headers: ['Brutto (CHF)', 'Netto bis 20 km', 'Netto über 20 km', 'Δ EUR/Jahr'],
        rows: [
          { cells: ['60.000', '~46.000 EUR', '~44.500 EUR', '-1.500'] },
          { cells: ['80.000', '~58.000 EUR', '~55.000 EUR', '-3.000'], emphasized: true },
          { cells: ['100.000', '~70.000 EUR', '~66.000 EUR', '-4.200'] },
        ],
        footnote: 'Richtwerte basierend auf Tessin-Tabellen 2026 + IRPEF mit EUR 10.000 Freibetrag.',
      },
      faqs: [
        { q: 'Wer gehört zu den neuen Grenzgängern über 20 km?', a: 'Wer das grenzüberschreitende Arbeitsverhältnis ab dem 17. Juli 2023 aufgenommen hat und in einer italienischen Gemeinde über 20 km von der Grenze wohnt.' },
        { q: 'Was ändert sich gegenüber bis 20 km?', a: 'Für neue Grenzgänger über 20 km behält die Schweiz 100 % der Quellensteuer ein. Bis 20 km behält die Schweiz 80 %, und Italien besteuert das Einkommen mit Anrechnung der bereits gezahlten Steuern.' },
        { q: 'Ersetzt diese Seite eine Steuerberatung?', a: 'Nein. Sie hilft, Szenarien einzuschätzen. Für Einzelfälle empfiehlt sich ein auf Grenzgänger spezialisierter Steuerberater.' },
      ],
    },
    fr: {
      eyebrow: 'Nouvel Accord 2024 · Plus de 20 km',
      tagline: 'Imposition concurrente : la Suisse retient 100 %, puis l\'Italie recalcule avec crédit d\'impôt.',
      tiles: [
        { label: 'Impôt à la source CH', value: '100%', tone: 'accent' },
        { label: 'Part aux communes IT', value: '0%', tone: 'danger' },
        { label: 'Charge fiscale extra', value: '+2-4k EUR/an', tone: 'warning' },
        { label: 'En vigueur depuis', value: 'le 17.07.2023', tone: 'neutral' },
      ],
      advice: 'Sur un brut de CHF 70 000, résider à plus de 20 km (ex. Milan) coûte environ EUR 3 000/an de plus que résider à moins de 20 km (ex. Côme), à brut égal.',
      ctaPrimary: { label: 'Calculer votre net', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer scénarios moins/plus de 20 km', href: '/fr/calculer-salaire/et-si/' },
      table: {
        caption: 'Écart net annuel : moins 20 km vs plus 20 km (A0N, Tessin)',
        headers: ['Brut (CHF)', 'Net moins 20 km', 'Net plus 20 km', 'Δ EUR/an'],
        rows: [
          { cells: ['60 000', '~46 000 EUR', '~44 500 EUR', '-1 500'] },
          { cells: ['80 000', '~58 000 EUR', '~55 000 EUR', '-3 000'], emphasized: true },
          { cells: ['100 000', '~70 000 EUR', '~66 000 EUR', '-4 200'] },
        ],
        footnote: 'Estimations indicatives basées sur les barèmes Tessin 2026 + IRPEF avec franchise EUR 10 000.',
      },
      faqs: [
        { q: 'Qui est nouveau frontalier au-delà de 20 km ?', a: 'Toute personne ayant débuté son emploi transfrontalier dès le 17 juillet 2023 et résidant dans une commune italienne à plus de 20 km de la frontière suisse.' },
        { q: 'Qu\'est-ce qui change vs moins de 20 km ?', a: 'Pour les nouveaux frontaliers au-delà de 20 km, la Suisse retient 100 % de l\'impôt à la source. Sous 20 km, la Suisse retient 80 % et l\'Italie impose avec crédit pour les impôts déjà payés.' },
        { q: 'Cette page remplace-t-elle un conseil fiscal ?', a: 'Non. Elle aide à comprendre les scénarios. Pour les cas particuliers, consultez un fiscaliste spécialisé frontaliers.' },
      ],
    },
  },

  'simula-busta-paga': {
    it: {
      eyebrow: 'Busta paga frontaliere · Ticino 2026',
      tagline: 'Decomposizione completa: lordo → contributi → imposta alla fonte → netto in CHF e EUR.',
      tiles: [
        { label: 'AVS / AI / IPG', value: '5,3%', tone: 'accent' },
        { label: 'Disoccupazione', value: '1,1%', tone: 'accent' },
        { label: 'LPP per età', value: '7-18%', tone: 'warning' },
        { label: 'Fonte cantonale', value: 'A · B · C · H', tone: 'neutral' },
      ],
      advice: 'Su CHF 6.000/mese di lordo, i contributi sociali tolgono ~CHF 380 prima ancora dell\'imposta alla fonte: pianifica i flussi conoscendo il netto vero, non il lordo.',
      ctaPrimary: { label: 'Apri il simulatore', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Cosa cambia se… (what-if)', href: '/calcola-stipendio/cosa-cambia-se/' },
      table: {
        caption: 'Esempio busta paga: lordo CHF 6.000/mese (A0N, Lugano)',
        headers: ['Voce', 'Aliquota', 'CHF/mese', 'EUR/mese'],
        rows: [
          { cells: ['Lordo', '—', '6.000', '~6.300'] },
          { cells: ['AVS/AI/IPG', '5,3%', '-318', '-334'] },
          { cells: ['Disoccupazione', '1,1%', '-66', '-69'] },
          { cells: ['LPP (età 35)', '10%', '-300', '-315'] },
          { cells: ['Fonte A0N', '~13%', '-700', '-735'] },
          { cells: ['Netto stimato', '—', '~4.616', '~4.847'], emphasized: true },
        ],
        footnote: 'Stima per scopi illustrativi. Il netto reale dipende da tabella fonte, comune, contratto LPP e benefit.',
      },
      faqs: [
        { q: 'Cosa include il netto della busta paga svizzera?', a: 'È il lordo meno AVS/AI/IPG (5,3%), AC (1,1%), LAA, IJM, LPP per fascia d\'età, e imposta alla fonte cantonale. Non include 13ª, benefit o assicurazioni complementari.' },
        { q: 'La 13ª è obbligatoria?', a: 'Dipende dal CCL settoriale. In Ticino la maggior parte dei settori la prevede; verifica sempre il contratto.' },
        { q: 'Il netto in EUR è fisso?', a: 'No: dipende dal cambio CHF/EUR del giorno. Il simulatore usa il tasso BNS aggiornato; valuta la sensibilità con scarti ±2%.' },
      ],
    },
    en: {
      eyebrow: 'Cross-border payslip · Ticino 2026',
      tagline: 'Full breakdown: gross → social charges → source tax → net in CHF and EUR.',
      tiles: [
        { label: 'AVS / AI / IPG', value: '5.3%', tone: 'accent' },
        { label: 'Unemployment', value: '1.1%', tone: 'accent' },
        { label: 'LPP by age', value: '7-18%', tone: 'warning' },
        { label: 'Cantonal source', value: 'A · B · C · H', tone: 'neutral' },
      ],
      advice: 'On a CHF 6,000/month gross, social charges alone take ~CHF 380 before source tax: plan cash flow on the real net, not the headline gross.',
      ctaPrimary: { label: 'Open the simulator', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'What-if simulator', href: '/en/calculate-salary/what-if/' },
      table: {
        caption: 'Sample payslip: CHF 6,000/month gross (A0N, Lugano)',
        headers: ['Line', 'Rate', 'CHF/month', 'EUR/month'],
        rows: [
          { cells: ['Gross', '—', '6,000', '~6,300'] },
          { cells: ['AVS/AI/IPG', '5.3%', '-318', '-334'] },
          { cells: ['Unemployment', '1.1%', '-66', '-69'] },
          { cells: ['LPP (age 35)', '10%', '-300', '-315'] },
          { cells: ['Source A0N', '~13%', '-700', '-735'] },
          { cells: ['Estimated net', '—', '~4,616', '~4,847'], emphasized: true },
        ],
        footnote: 'Illustrative only. Actual net depends on source-tax table, municipality, LPP plan and benefits.',
      },
      faqs: [
        { q: 'What does the Swiss net payslip include?', a: 'Gross minus AVS/AI/IPG (5.3%), unemployment (1.1%), accident, daily sickness, LPP by age bracket and cantonal source tax. It excludes 13th-month pay, benefits and supplementary insurance.' },
        { q: 'Is the 13th-month mandatory?', a: 'It depends on the sectoral CCL. Most Ticino sectors require it; always check your contract.' },
        { q: 'Is the EUR net fixed?', a: 'No: it depends on the CHF/EUR exchange rate. The simulator uses the daily SNB rate; stress-test with ±2% swings.' },
      ],
    },
    de: {
      eyebrow: 'Grenzgänger-Lohnabrechnung · Tessin 2026',
      tagline: 'Vollständige Aufschlüsselung: Brutto → Sozialabgaben → Quellensteuer → Netto in CHF und EUR.',
      tiles: [
        { label: 'AHV / IV / EO', value: '5,3%', tone: 'accent' },
        { label: 'Arbeitslosen', value: '1,1%', tone: 'accent' },
        { label: 'BVG nach Alter', value: '7-18%', tone: 'warning' },
        { label: 'Kantonale Quelle', value: 'A · B · C · H', tone: 'neutral' },
      ],
      advice: 'Bei CHF 6.000/Monat brutto entfallen schon ~CHF 380 auf Sozialabgaben — plane mit dem echten Netto, nicht mit dem Brutto.',
      ctaPrimary: { label: 'Simulator öffnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Was-wäre-wenn-Simulator', href: '/de/gehalt-berechnen/was-waere-wenn/' },
      table: {
        caption: 'Beispiel-Lohnabrechnung: CHF 6.000/Monat brutto (A0N, Lugano)',
        headers: ['Position', 'Satz', 'CHF/Monat', 'EUR/Monat'],
        rows: [
          { cells: ['Brutto', '—', '6.000', '~6.300'] },
          { cells: ['AHV/IV/EO', '5,3%', '-318', '-334'] },
          { cells: ['Arbeitslosen', '1,1%', '-66', '-69'] },
          { cells: ['BVG (Alter 35)', '10%', '-300', '-315'] },
          { cells: ['Quelle A0N', '~13%', '-700', '-735'] },
          { cells: ['Geschätztes Netto', '—', '~4.616', '~4.847'], emphasized: true },
        ],
        footnote: 'Nur illustrativ. Das tatsächliche Netto hängt von Quellensteuer-Tabelle, Gemeinde, BVG-Plan und Zusatzleistungen ab.',
      },
      faqs: [
        { q: 'Was umfasst das Schweizer Netto?', a: 'Brutto abzüglich AHV/IV/EO (5,3 %), Arbeitslosen (1,1 %), Unfall, Krankentaggeld, BVG nach Alter und kantonale Quellensteuer. Ohne 13. Monatslohn, Zusatzleistungen und Versicherungen.' },
        { q: 'Ist der 13. Monatslohn obligatorisch?', a: 'Hängt vom Branchen-GAV ab. In den meisten Tessiner Branchen ja — Vertrag prüfen.' },
        { q: 'Ist das EUR-Netto fix?', a: 'Nein, es hängt vom CHF/EUR-Kurs ab. Der Simulator nutzt den aktuellen SNB-Kurs; rechne mit ±2 % Schwankungsbreite.' },
      ],
    },
    fr: {
      eyebrow: 'Fiche de paie frontalier · Tessin 2026',
      tagline: 'Décomposition complète : brut → cotisations → impôt à la source → net en CHF et EUR.',
      tiles: [
        { label: 'AVS / AI / APG', value: '5,3%', tone: 'accent' },
        { label: 'Chômage', value: '1,1%', tone: 'accent' },
        { label: 'LPP par âge', value: '7-18%', tone: 'warning' },
        { label: 'Source cantonale', value: 'A · B · C · H', tone: 'neutral' },
      ],
      advice: 'Sur CHF 6 000/mois brut, les cotisations sociales prélèvent déjà ~CHF 380 avant l\'impôt à la source — raisonnez sur le vrai net, pas le brut affiché.',
      ctaPrimary: { label: 'Ouvrir le simulateur', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Simulateur et-si', href: '/fr/calculer-salaire/et-si/' },
      table: {
        caption: 'Exemple fiche de paie : CHF 6 000/mois brut (A0N, Lugano)',
        headers: ['Poste', 'Taux', 'CHF/mois', 'EUR/mois'],
        rows: [
          { cells: ['Brut', '—', '6 000', '~6 300'] },
          { cells: ['AVS/AI/APG', '5,3%', '-318', '-334'] },
          { cells: ['Chômage', '1,1%', '-66', '-69'] },
          { cells: ['LPP (35 ans)', '10%', '-300', '-315'] },
          { cells: ['Source A0N', '~13%', '-700', '-735'] },
          { cells: ['Net estimé', '—', '~4 616', '~4 847'], emphasized: true },
        ],
        footnote: 'Illustration uniquement. Le net réel dépend du barème source, de la commune, du plan LPP et des avantages.',
      },
      faqs: [
        { q: 'Que contient le net suisse ?', a: 'Le brut moins AVS/AI/APG (5,3 %), chômage (1,1 %), accident, indemnités journalières maladie, LPP selon l\'âge et impôt à la source cantonal. Hors 13e mois, avantages et assurances complémentaires.' },
        { q: 'Le 13e mois est-il obligatoire ?', a: 'Cela dépend de la CCT sectorielle. Au Tessin la plupart des secteurs l\'imposent — vérifiez votre contrat.' },
        { q: 'Le net en EUR est-il fixe ?', a: 'Non : il dépend du taux CHF/EUR. Le simulateur utilise le taux BNS du jour ; testez ±2 % de variation.' },
      ],
    },
  },

  'cosa-cambia-se': {
    it: {
      eyebrow: 'What-if simulator · Frontaliere',
      tagline: 'Vari un parametro alla volta — stato civile, distanza, figli, % lavoro — e vedi l\'impatto sul netto.',
      tiles: [
        { label: 'Parametri variabili', value: '6+', tone: 'accent' },
        { label: 'Fonte tabella', value: 'A → C', tone: 'warning' },
        { label: 'Distanza confine', value: '≤20 vs >20 km', tone: 'danger' },
        { label: 'Output', value: 'Δ in CHF + EUR', tone: 'success' },
      ],
      advice: 'Passare da A0 (single) a C2 (sposato, 2 figli) può cambiare il netto annuo di CHF 4.000–6.000 a parità di lordo: simula prima di firmare un contratto o cambiare residenza.',
      ctaPrimary: { label: 'Apri il what-if', href: '/calcola-stipendio/cosa-cambia-se/' },
      ctaSecondary: { label: 'Vai al simulatore base', href: '/calcola-stipendio/' },
      table: {
        caption: 'Esempi delta netto annuo a parità di lordo CHF 80.000',
        headers: ['Scenario base', 'Variazione', 'Delta netto/anno'],
        rows: [
          { cells: ['Single A0', 'Matrimonio → C0', '+CHF 2.800'] },
          { cells: ['Sposato C0', 'Nascita figlio → C1', '+CHF 1.500'] },
          { cells: ['Entro 20 km', 'Trasloco oltre 20 km', '-EUR 3.000'], emphasized: true },
          { cells: ['100% lavoro', 'Passaggio 80%', '-CHF 14.000 lordi · -CHF 9.500 netti'] },
        ],
        footnote: 'Stime in tabella Ticino 2026; il simulatore calcola il tuo caso esatto.',
      },
      faqs: [
        { q: 'Quali parametri posso variare?', a: 'Stato civile, figli a carico, distanza dal confine, percentuale di lavoro, cantone, fascia d\'età LPP, comune di residenza.' },
        { q: 'Posso confrontare due scenari fianco a fianco?', a: 'Sì: il what-if mostra il delta netto in CHF e EUR, evidenziando le voci più impattate (fonte, LPP, IRPEF).' },
        { q: 'Posso esportare il risultato?', a: 'Sì, in PDF per condividerlo con commercialista o datore di lavoro durante la trattativa salariale.' },
      ],
    },
    en: {
      eyebrow: 'What-if simulator · Cross-border',
      tagline: 'Tweak one parameter at a time — marital status, distance, kids, work share — and see the net impact.',
      tiles: [
        { label: 'Variable parameters', value: '6+', tone: 'accent' },
        { label: 'Source table', value: 'A → C', tone: 'warning' },
        { label: 'Border distance', value: '≤20 vs >20 km', tone: 'danger' },
        { label: 'Output', value: 'Δ in CHF + EUR', tone: 'success' },
      ],
      advice: 'Going from A0 (single) to C2 (married, 2 kids) can shift annual net by CHF 4,000–6,000 at the same gross: simulate before signing a contract or moving home.',
      ctaPrimary: { label: 'Open what-if', href: '/en/calculate-salary/what-if/' },
      ctaSecondary: { label: 'Go to base simulator', href: '/en/calculate-salary/' },
      table: {
        caption: 'Annual net delta examples at CHF 80,000 gross',
        headers: ['Base scenario', 'Change', 'Net delta/year'],
        rows: [
          { cells: ['Single A0', 'Marriage → C0', '+CHF 2,800'] },
          { cells: ['Married C0', 'Child → C1', '+CHF 1,500'] },
          { cells: ['Within 20 km', 'Move over 20 km', '-EUR 3,000'], emphasized: true },
          { cells: ['100% workload', 'Drop to 80%', '-CHF 14,000 gross · -CHF 9,500 net'] },
        ],
        footnote: 'Estimates on Ticino 2026 tables; the simulator computes your exact case.',
      },
      faqs: [
        { q: 'Which parameters can I change?', a: 'Marital status, dependent children, distance from the border, work share, canton, LPP age bracket, municipality.' },
        { q: 'Can I compare two scenarios side-by-side?', a: 'Yes: the what-if shows net delta in CHF and EUR, highlighting the most impacted lines (source tax, LPP, IRPEF).' },
        { q: 'Can I export the result?', a: 'Yes, as PDF to share with your accountant or employer during salary negotiation.' },
      ],
    },
    de: {
      eyebrow: 'Was-wäre-wenn-Simulator · Grenzgänger',
      tagline: 'Einen Parameter ändern — Familienstand, Distanz, Kinder, Pensum — und die Netto-Wirkung sehen.',
      tiles: [
        { label: 'Variable Parameter', value: '6+', tone: 'accent' },
        { label: 'Quellentabelle', value: 'A → C', tone: 'warning' },
        { label: 'Grenzdistanz', value: '≤20 vs >20 km', tone: 'danger' },
        { label: 'Ergebnis', value: 'Δ in CHF + EUR', tone: 'success' },
      ],
      advice: 'Von A0 (ledig) zu C2 (verheiratet, 2 Kinder) kann das Jahresnetto bei gleichem Brutto um CHF 4.000–6.000 schwanken — vor Vertragsunterschrift simulieren.',
      ctaPrimary: { label: 'Was-wäre-wenn öffnen', href: '/de/gehalt-berechnen/was-waere-wenn/' },
      ctaSecondary: { label: 'Zum Basis-Simulator', href: '/de/gehalt-berechnen/' },
      table: {
        caption: 'Jahresnetto-Differenz bei Brutto CHF 80.000',
        headers: ['Basis', 'Änderung', 'Netto-Differenz/Jahr'],
        rows: [
          { cells: ['Ledig A0', 'Heirat → C0', '+CHF 2.800'] },
          { cells: ['Verheiratet C0', 'Kind → C1', '+CHF 1.500'] },
          { cells: ['Bis 20 km', 'Umzug über 20 km', '-EUR 3.000'], emphasized: true },
          { cells: ['100% Pensum', 'Reduktion 80%', '-CHF 14.000 brutto · -CHF 9.500 netto'] },
        ],
        footnote: 'Richtwerte auf Tessin-Tabellen 2026; der Simulator rechnet Ihren konkreten Fall.',
      },
      faqs: [
        { q: 'Welche Parameter kann ich ändern?', a: 'Familienstand, unterhaltsberechtigte Kinder, Grenzdistanz, Pensum, Kanton, BVG-Altersband, Wohngemeinde.' },
        { q: 'Kann ich zwei Szenarien nebeneinander vergleichen?', a: 'Ja: Der Was-wäre-wenn zeigt die Netto-Differenz in CHF und EUR und hebt die am stärksten betroffenen Positionen hervor.' },
        { q: 'Kann ich das Ergebnis exportieren?', a: 'Ja, als PDF zur Weitergabe an Treuhänder oder Arbeitgeber bei Gehaltsverhandlungen.' },
      ],
    },
    fr: {
      eyebrow: 'Simulateur et-si · Frontalier',
      tagline: 'Modifiez un paramètre à la fois — état civil, distance, enfants, taux — et voyez l\'impact net.',
      tiles: [
        { label: 'Paramètres variables', value: '6+', tone: 'accent' },
        { label: 'Barème source', value: 'A → C', tone: 'warning' },
        { label: 'Distance frontière', value: '≤20 vs >20 km', tone: 'danger' },
        { label: 'Sortie', value: 'Δ en CHF + EUR', tone: 'success' },
      ],
      advice: 'Passer de A0 (célibataire) à C2 (marié, 2 enfants) peut faire varier le net annuel de CHF 4 000 à 6 000 à brut égal — simulez avant de signer.',
      ctaPrimary: { label: 'Ouvrir et-si', href: '/fr/calculer-salaire/et-si/' },
      ctaSecondary: { label: 'Aller au simulateur de base', href: '/fr/calculer-salaire/' },
      table: {
        caption: 'Exemples de delta net annuel à brut CHF 80 000',
        headers: ['Scénario de base', 'Changement', 'Delta net/an'],
        rows: [
          { cells: ['Célibataire A0', 'Mariage → C0', '+CHF 2 800'] },
          { cells: ['Marié C0', 'Naissance enfant → C1', '+CHF 1 500'] },
          { cells: ['Moins 20 km', 'Déménagement plus 20 km', '-EUR 3 000'], emphasized: true },
          { cells: ['100% travail', 'Passage 80%', '-CHF 14 000 brut · -CHF 9 500 net'] },
        ],
        footnote: 'Estimations sur barèmes Tessin 2026 ; le simulateur calcule votre cas exact.',
      },
      faqs: [
        { q: 'Quels paramètres puis-je modifier ?', a: 'État civil, enfants à charge, distance frontière, taux d\'activité, canton, tranche d\'âge LPP, commune.' },
        { q: 'Puis-je comparer deux scénarios côte à côte ?', a: 'Oui : l\'et-si montre le delta net en CHF et EUR, mettant en évidence les postes les plus impactés (source, LPP, IRPEF).' },
        { q: 'Puis-je exporter le résultat ?', a: 'Oui, en PDF pour le partager avec votre fiscaliste ou employeur en négociation salariale.' },
      ],
    },
  },

  'confronta-stipendi': {
    it: {
      eyebrow: 'Confronto Ticino vs Italia',
      tagline: 'Stesso ruolo, due paesi: stipendio netto reale dopo tasse, contributi e costo della vita.',
      tiles: [
        { label: 'Differenza media', value: '+40-60% CH', tone: 'success' },
        { label: 'Spesa CH vs IT', value: '+35-55%', tone: 'warning' },
        { label: 'Trasporto frontaliere', value: '200-400 EUR/m', tone: 'danger' },
        { label: 'Costo cassa malati', value: '200-600 CHF/m', tone: 'warning' },
      ],
      advice: 'CHF 70.000 a Lugano valgono ~EUR 47.000 netti in tasca dopo trasporto + LAMal: confrontalo con un\'offerta da EUR 40.000 a Milano per capire il vero margine.',
      ctaPrimary: { label: 'Apri il confronto', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronta offerte specifiche', href: '/compara-servizi/confronta-offerte-lavoro/' },
      table: {
        caption: 'Ruolo equivalente in Ticino vs Lombardia (sviluppatore senior)',
        headers: ['Voce', 'Ticino', 'Italia'],
        rows: [
          { cells: ['Lordo annuo', 'CHF 85.000', 'EUR 50.000'] },
          { cells: ['Netto annuo', '~CHF 64.000 (~EUR 67.000)', '~EUR 30.500'], emphasized: true },
          { cells: ['Trasporto CH', '-EUR 3.500', '—'] },
          { cells: ['Cassa malati', '-CHF 4.800', 'inclusa SSN'] },
          { cells: ['Netto in tasca', '~EUR 58.000', '~EUR 30.500'] },
        ],
        footnote: 'Approssimazioni per profilo single 30 anni, Como vs Milano. Il simulatore calcola il tuo caso.',
      },
      faqs: [
        { q: 'Conviene sempre lavorare in Svizzera?', a: 'Quasi sempre per il netto in tasca, ma dipende da costi accessori: trasporto, cassa malati, e tempo di pendolarismo (costo-opportunità).' },
        { q: 'Conta la qualità della vita?', a: 'Sì: 2 h/giorno di pendolarismo equivalgono a ~10% in meno di tempo libero — fattorizzalo nelle scelte.' },
        { q: 'Posso confrontare profili diversi?', a: 'Sì: lo strumento varia ruolo, livello, settore e città in entrambi i paesi.' },
      ],
    },
    en: {
      eyebrow: 'Ticino vs Italy comparison',
      tagline: 'Same role, two countries: real net pay after tax, contributions and cost of living.',
      tiles: [
        { label: 'Average gap', value: '+40-60% CH', tone: 'success' },
        { label: 'Grocery CH vs IT', value: '+35-55%', tone: 'warning' },
        { label: 'Cross-border travel', value: '200-400 EUR/mo', tone: 'danger' },
        { label: 'Health insurance', value: '200-600 CHF/mo', tone: 'warning' },
      ],
      advice: 'CHF 70,000 in Lugano nets ~EUR 47,000 in pocket after travel + LAMal: weigh it against an EUR 40,000 Milan offer to see the true margin.',
      ctaPrimary: { label: 'Open the comparison', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'Compare specific offers', href: '/en/comparators/compare-job-offers/' },
      table: {
        caption: 'Equivalent role: Ticino vs Lombardy (senior developer)',
        headers: ['Line', 'Ticino', 'Italy'],
        rows: [
          { cells: ['Annual gross', 'CHF 85,000', 'EUR 50,000'] },
          { cells: ['Annual net', '~CHF 64,000 (~EUR 67,000)', '~EUR 30,500'], emphasized: true },
          { cells: ['CH transport', '-EUR 3,500', '—'] },
          { cells: ['Health insurance', '-CHF 4,800', 'SSN included'] },
          { cells: ['Net in pocket', '~EUR 58,000', '~EUR 30,500'] },
        ],
        footnote: 'Approx. for single 30 y/o, Como vs Milan. Use the simulator for your case.',
      },
      faqs: [
        { q: 'Is Switzerland always worth it?', a: 'Usually for net pay, but it depends on side costs: commute, health insurance, and commute time (opportunity cost).' },
        { q: 'Does quality of life matter?', a: 'Yes: 2 h/day commute equals ~10 % less free time — factor it into your choice.' },
        { q: 'Can I compare different profiles?', a: 'Yes: the tool varies role, seniority, sector and city across both countries.' },
      ],
    },
    de: {
      eyebrow: 'Tessin vs. Italien Vergleich',
      tagline: 'Gleiche Rolle, zwei Länder: tatsächliches Netto nach Steuern, Abgaben und Lebenskosten.',
      tiles: [
        { label: 'Mittlerer Unterschied', value: '+40-60% CH', tone: 'success' },
        { label: 'Lebensmittel CH vs IT', value: '+35-55%', tone: 'warning' },
        { label: 'Grenzgänger-Pendel', value: '200-400 EUR/Mt', tone: 'danger' },
        { label: 'Krankenkasse', value: '200-600 CHF/Mt', tone: 'warning' },
      ],
      advice: 'CHF 70.000 in Lugano ergeben ~EUR 47.000 netto nach Pendel + LAMal: vergleichen Sie mit EUR 40.000 in Mailand, um die echte Marge zu sehen.',
      ctaPrimary: { label: 'Vergleich öffnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Spezifische Angebote vergleichen', href: '/de/comparators/jobangebote-vergleichen/' },
      table: {
        caption: 'Gleichwertige Rolle: Tessin vs. Lombardei (Senior-Entwickler)',
        headers: ['Position', 'Tessin', 'Italien'],
        rows: [
          { cells: ['Brutto Jahr', 'CHF 85.000', 'EUR 50.000'] },
          { cells: ['Netto Jahr', '~CHF 64.000 (~EUR 67.000)', '~EUR 30.500'], emphasized: true },
          { cells: ['CH-Transport', '-EUR 3.500', '—'] },
          { cells: ['Krankenkasse', '-CHF 4.800', 'SSN inklusive'] },
          { cells: ['Netto in der Tasche', '~EUR 58.000', '~EUR 30.500'] },
        ],
        footnote: 'Richtwerte für Single 30 J., Como vs. Mailand. Nutzen Sie den Simulator für Ihren Fall.',
      },
      faqs: [
        { q: 'Lohnt sich die Schweiz immer?', a: 'Meist beim Netto, aber abhängig von Nebenkosten: Pendel, Krankenkasse, Pendelzeit (Opportunitätskosten).' },
        { q: 'Zählt Lebensqualität?', a: 'Ja: 2 h/Tag Pendel = ~10 % weniger Freizeit. In die Entscheidung einbeziehen.' },
        { q: 'Kann ich verschiedene Profile vergleichen?', a: 'Ja: das Tool variiert Rolle, Senioritätsstufe, Branche und Stadt in beiden Ländern.' },
      ],
    },
    fr: {
      eyebrow: 'Comparaison Tessin vs Italie',
      tagline: 'Même rôle, deux pays : salaire net réel après impôts, cotisations et coût de la vie.',
      tiles: [
        { label: 'Écart moyen', value: '+40-60% CH', tone: 'success' },
        { label: 'Courses CH vs IT', value: '+35-55%', tone: 'warning' },
        { label: 'Transport frontalier', value: '200-400 EUR/m', tone: 'danger' },
        { label: 'Caisse maladie', value: '200-600 CHF/m', tone: 'warning' },
      ],
      advice: 'CHF 70 000 à Lugano valent ~EUR 47 000 nets après transport + LAMal : comparez avec une offre EUR 40 000 à Milan pour la vraie marge.',
      ctaPrimary: { label: 'Ouvrir la comparaison', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer des offres précises', href: '/fr/comparators/comparer-offres-emploi/' },
      table: {
        caption: 'Rôle équivalent : Tessin vs Lombardie (dév. senior)',
        headers: ['Poste', 'Tessin', 'Italie'],
        rows: [
          { cells: ['Brut annuel', 'CHF 85 000', 'EUR 50 000'] },
          { cells: ['Net annuel', '~CHF 64 000 (~EUR 67 000)', '~EUR 30 500'], emphasized: true },
          { cells: ['Transport CH', '-EUR 3 500', '—'] },
          { cells: ['Caisse maladie', '-CHF 4 800', 'SSN inclus'] },
          { cells: ['Net en poche', '~EUR 58 000', '~EUR 30 500'] },
        ],
        footnote: 'Estimations pour célibataire 30 ans, Côme vs Milan. Le simulateur calcule votre cas.',
      },
      faqs: [
        { q: 'La Suisse est-elle toujours plus intéressante ?', a: 'Souvent pour le net, mais selon les coûts annexes : transport, caisse maladie, temps de trajet (coût d\'opportunité).' },
        { q: 'La qualité de vie compte-t-elle ?', a: 'Oui : 2 h/jour de trajet = ~10 % de temps libre en moins. À intégrer dans le choix.' },
        { q: 'Puis-je comparer différents profils ?', a: 'Oui : l\'outil fait varier rôle, séniorité, secteur et ville dans les deux pays.' },
      ],
    },
  },

  'quanto-guadagneresti-in-svizzera': {
    it: {
      eyebrow: 'Quiz fiscale settimanale',
      tagline: '5 domande, 8 minuti: testa quanto sai davvero su tasse, contributi e franchigia.',
      tiles: [
        { label: 'Domande', value: '5 / 5', tone: 'accent' },
        { label: 'Aree coperte', value: '4 temi', tone: 'success' },
        { label: 'Durata', value: '6-8 min', tone: 'neutral' },
        { label: 'Pool totale', value: '20 quiz', tone: 'warning' },
      ],
      advice: 'Il quiz è anche didattico: ogni risposta sbagliata sblocca una spiegazione con riferimento normativo. Usalo prima di una trattativa salariale.',
      ctaPrimary: { label: 'Inizia il quiz', href: '/calcola-stipendio/quiz-stipendio/' },
      ctaSecondary: { label: 'Vai al simulatore', href: '/calcola-stipendio/' },
      table: {
        caption: 'Aree coperte dal pool di 20 domande',
        headers: ['Area', 'Esempi di domanda', 'Quiz nel pool'],
        rows: [
          { cells: ['Fiscalità CH', 'Aliquote fonte tabella A/B/C', '5'] },
          { cells: ['Fiscalità IT', 'Franchigia 10.000 EUR e quadro CE', '5'], emphasized: true },
          { cells: ['Contributi', 'AVS 5,3% · LPP per età', '5'] },
          { cells: ['Permessi & LAMal', 'Permesso G vs B · diritto opzione', '5'] },
        ],
        footnote: 'Le domande ruotano trimestralmente per riflettere aggiornamenti normativi.',
      },
      faqs: [
        { q: 'Il quiz è gratuito?', a: 'Sì, completamente. Nessuna registrazione richiesta per provarlo.' },
        { q: 'Cosa succede se sbaglio?', a: 'Ogni risposta sbagliata mostra la spiegazione passo-passo e il riferimento normativo. È pensato per imparare.' },
        { q: 'Posso rifarlo?', a: 'Sì: ogni settimana vengono estratte 5 domande nuove dal pool di 20.' },
      ],
    },
    en: {
      eyebrow: 'Weekly tax quiz',
      tagline: '5 questions, 8 minutes: test how much you really know about taxes, contributions and allowances.',
      tiles: [
        { label: 'Questions', value: '5 / 5', tone: 'accent' },
        { label: 'Topic areas', value: '4 themes', tone: 'success' },
        { label: 'Duration', value: '6-8 min', tone: 'neutral' },
        { label: 'Total pool', value: '20 quizzes', tone: 'warning' },
      ],
      advice: 'The quiz is educational: every wrong answer unlocks an explanation with the underlying rule. Run it before a salary negotiation.',
      ctaPrimary: { label: 'Start the quiz', href: '/en/calculate-salary/salary-quiz/' },
      ctaSecondary: { label: 'Go to the simulator', href: '/en/calculate-salary/' },
      table: {
        caption: 'Topics covered by the 20-question pool',
        headers: ['Area', 'Example question', 'Quizzes in pool'],
        rows: [
          { cells: ['Swiss tax', 'Source-tax rates table A/B/C', '5'] },
          { cells: ['Italian tax', 'EUR 10,000 allowance and CE schedule', '5'], emphasized: true },
          { cells: ['Contributions', 'AVS 5.3% · LPP by age', '5'] },
          { cells: ['Permits & LAMal', 'Permit G vs B · opt-in right', '5'] },
        ],
        footnote: 'Questions rotate quarterly to reflect regulatory updates.',
      },
      faqs: [
        { q: 'Is the quiz free?', a: 'Yes, completely. No sign-up required to try it.' },
        { q: 'What happens when I get it wrong?', a: 'Each wrong answer shows the step-by-step explanation and the regulatory reference. It is built to teach.' },
        { q: 'Can I retake it?', a: 'Yes: every week 5 new questions are drawn from the 20-question pool.' },
      ],
    },
    de: {
      eyebrow: 'Wöchentliches Steuerquiz',
      tagline: '5 Fragen, 8 Minuten: testen Sie Ihr Wissen zu Steuern, Beiträgen und Freibeträgen.',
      tiles: [
        { label: 'Fragen', value: '5 / 5', tone: 'accent' },
        { label: 'Themenbereiche', value: '4 Themen', tone: 'success' },
        { label: 'Dauer', value: '6-8 Min', tone: 'neutral' },
        { label: 'Gesamtpool', value: '20 Quizfragen', tone: 'warning' },
      ],
      advice: 'Das Quiz ist auch lehrreich: jede falsche Antwort liefert die Erklärung mit Rechtsgrundlage. Ideal vor einer Gehaltsverhandlung.',
      ctaPrimary: { label: 'Quiz starten', href: '/de/gehalt-berechnen/gehaltsquiz/' },
      ctaSecondary: { label: 'Zum Simulator', href: '/de/gehalt-berechnen/' },
      table: {
        caption: 'Themen im 20-Fragen-Pool',
        headers: ['Bereich', 'Beispiel-Frage', 'Quizfragen im Pool'],
        rows: [
          { cells: ['CH-Steuern', 'Quellensteuersätze Tabelle A/B/C', '5'] },
          { cells: ['IT-Steuern', 'EUR 10.000 Freibetrag und CE-Vordruck', '5'], emphasized: true },
          { cells: ['Beiträge', 'AHV 5,3 % · BVG nach Alter', '5'] },
          { cells: ['Bewilligungen & LAMal', 'G vs B · Optionsrecht', '5'] },
        ],
        footnote: 'Fragen rotieren quartalsweise und spiegeln Gesetzesänderungen wider.',
      },
      faqs: [
        { q: 'Ist das Quiz kostenlos?', a: 'Ja, komplett. Keine Registrierung erforderlich.' },
        { q: 'Was passiert bei falscher Antwort?', a: 'Jede falsche Antwort zeigt die Schritt-für-Schritt-Erklärung und Rechtsgrundlage. Lerneffekt eingebaut.' },
        { q: 'Kann ich es wiederholen?', a: 'Ja: jede Woche werden 5 neue Fragen aus dem 20-Fragen-Pool gezogen.' },
      ],
    },
    fr: {
      eyebrow: 'Quiz fiscal hebdomadaire',
      tagline: '5 questions, 8 minutes : testez vos connaissances sur impôts, cotisations et franchise.',
      tiles: [
        { label: 'Questions', value: '5 / 5', tone: 'accent' },
        { label: 'Domaines', value: '4 thèmes', tone: 'success' },
        { label: 'Durée', value: '6-8 min', tone: 'neutral' },
        { label: 'Pool total', value: '20 quiz', tone: 'warning' },
      ],
      advice: 'Le quiz est pédagogique : chaque mauvaise réponse débloque une explication avec référence. Idéal avant une négo salariale.',
      ctaPrimary: { label: 'Démarrer le quiz', href: '/fr/calculer-salaire/quiz-salaire/' },
      ctaSecondary: { label: 'Aller au simulateur', href: '/fr/calculer-salaire/' },
      table: {
        caption: 'Domaines couverts par le pool de 20 questions',
        headers: ['Domaine', 'Exemple de question', 'Quiz dans le pool'],
        rows: [
          { cells: ['Fiscalité CH', 'Taux impôt source A/B/C', '5'] },
          { cells: ['Fiscalité IT', 'Franchise EUR 10 000 et quadro CE', '5'], emphasized: true },
          { cells: ['Cotisations', 'AVS 5,3 % · LPP par âge', '5'] },
          { cells: ['Permis & LAMal', 'Permis G vs B · droit d\'option', '5'] },
        ],
        footnote: 'Les questions tournent chaque trimestre pour refléter les mises à jour.',
      },
      faqs: [
        { q: 'Le quiz est-il gratuit ?', a: 'Oui, totalement. Aucune inscription requise pour essayer.' },
        { q: 'Que se passe-t-il si je me trompe ?', a: 'Chaque mauvaise réponse affiche l\'explication pas à pas et la référence. Conçu pour apprendre.' },
        { q: 'Puis-je le refaire ?', a: 'Oui : chaque semaine 5 nouvelles questions sont tirées du pool de 20.' },
      ],
    },
  },

  'confronta-retribuzione-ral': {
    it: {
      eyebrow: 'Da RAL svizzera a netto reale',
      tagline: 'CHF 80.000 lordi ≠ CHF 80.000 netti: vediamo cosa resta dopo AVS, LPP e imposta alla fonte.',
      tiles: [
        { label: 'RAL CHF 80k', value: '~CHF 58k netti', tone: 'accent' },
        { label: 'Contributi tot.', value: '14-22%', tone: 'warning' },
        { label: 'LPP 50+ anni', value: '+18%', tone: 'danger' },
        { label: '13ª mensilità', value: 'Standard CH', tone: 'success' },
      ],
      advice: 'Tra RAL svizzera ed equivalente italiano lo scarto reale è 40-60% maggiore di quello sui lordi: confronta i netti veri prima di firmare.',
      ctaPrimary: { label: 'Calcola il netto dalla RAL', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronta due offerte', href: '/compara-servizi/confronta-offerte-lavoro/' },
      table: {
        caption: 'Conversione RAL → netto stimato (single A0, Lugano)',
        headers: ['RAL CHF', 'Netto mensile', 'Netto annuo', 'Netto in EUR'],
        rows: [
          { cells: ['60.000', '~CHF 4.000', '~CHF 48.000', '~EUR 50.000'] },
          { cells: ['80.000', '~CHF 4.800', '~CHF 58.000', '~EUR 60.500'], emphasized: true },
          { cells: ['100.000', '~CHF 5.800', '~CHF 70.000', '~EUR 73.500'] },
          { cells: ['120.000', '~CHF 6.700', '~CHF 80.500', '~EUR 84.500'] },
        ],
        footnote: 'Stime per fascia LPP 25-34, Lugano. Per età 50+ il LPP sale al 18% e il netto cala ~CHF 4.000/anno.',
      },
      faqs: [
        { q: 'Cos\'è esattamente la RAL svizzera?', a: 'Retribuzione Annua Lorda: include 12 o 13 mensilità a seconda del settore, ma non i benefit (assicurazione integrativa, buoni pasto, parcheggio).' },
        { q: 'I contributi datore di lavoro contano?', a: 'No nel calcolo del netto, ma sì come "total compensation": il datore versa ~50% del LPP e contributi paralleli a famiglia/infortuni.' },
        { q: 'Quanto incide l\'età sul netto?', a: 'Molto: il LPP passa dal 7% (25-34) al 18% (55-65) e può togliere CHF 4-6k netti/anno a parità di lordo.' },
      ],
    },
    en: {
      eyebrow: 'From Swiss gross (RAL) to real net',
      tagline: 'CHF 80,000 gross ≠ CHF 80,000 net: see what\'s left after AVS, LPP and source tax.',
      tiles: [
        { label: 'CHF 80k gross', value: '~CHF 58k net', tone: 'accent' },
        { label: 'Total contrib.', value: '14-22%', tone: 'warning' },
        { label: 'LPP age 50+', value: '+18%', tone: 'danger' },
        { label: '13th month', value: 'Standard CH', tone: 'success' },
      ],
      advice: 'The real Swiss-vs-Italian gap is 40-60% wider than the gross suggests: compare actual nets before signing.',
      ctaPrimary: { label: 'Calculate net from gross', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'Compare two offers', href: '/en/comparators/compare-job-offers/' },
      table: {
        caption: 'Gross → estimated net (single A0, Lugano)',
        headers: ['CHF gross', 'Monthly net', 'Annual net', 'Net in EUR'],
        rows: [
          { cells: ['60,000', '~CHF 4,000', '~CHF 48,000', '~EUR 50,000'] },
          { cells: ['80,000', '~CHF 4,800', '~CHF 58,000', '~EUR 60,500'], emphasized: true },
          { cells: ['100,000', '~CHF 5,800', '~CHF 70,000', '~EUR 73,500'] },
          { cells: ['120,000', '~CHF 6,700', '~CHF 80,500', '~EUR 84,500'] },
        ],
        footnote: 'Estimates for LPP bracket 25-34, Lugano. From age 50+ LPP rises to 18% and net drops ~CHF 4,000/year.',
      },
      faqs: [
        { q: 'What is Swiss RAL exactly?', a: 'Annual Gross Salary: includes 12 or 13 monthly payments depending on the sector, but not benefits (supplementary insurance, meal vouchers, parking).' },
        { q: 'Do employer contributions count?', a: 'Not in net calculation, but yes as "total compensation": the employer pays ~50% of LPP plus family/accident contributions.' },
        { q: 'How does age affect net pay?', a: 'A lot: LPP goes from 7% (25-34) to 18% (55-65) and can remove CHF 4-6k net/year at the same gross.' },
      ],
    },
    de: {
      eyebrow: 'Vom Schweizer Brutto (RAL) zum echten Netto',
      tagline: 'CHF 80.000 brutto ≠ CHF 80.000 netto: was nach AHV, BVG und Quellensteuer übrig bleibt.',
      tiles: [
        { label: 'CHF 80k brutto', value: '~CHF 58k netto', tone: 'accent' },
        { label: 'Beiträge total', value: '14-22%', tone: 'warning' },
        { label: 'BVG 50+', value: '+18%', tone: 'danger' },
        { label: '13. Monatslohn', value: 'CH-Standard', tone: 'success' },
      ],
      advice: 'Die echte Differenz Schweiz vs. Italien ist 40-60 % grösser als der Brutto-Vergleich vermuten lässt — vergleichen Sie die echten Nettos vor der Unterschrift.',
      ctaPrimary: { label: 'Netto vom Brutto berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Zwei Angebote vergleichen', href: '/de/comparators/jobangebote-vergleichen/' },
      table: {
        caption: 'Brutto → geschätztes Netto (ledig A0, Lugano)',
        headers: ['CHF brutto', 'Netto/Monat', 'Netto/Jahr', 'Netto in EUR'],
        rows: [
          { cells: ['60.000', '~CHF 4.000', '~CHF 48.000', '~EUR 50.000'] },
          { cells: ['80.000', '~CHF 4.800', '~CHF 58.000', '~EUR 60.500'], emphasized: true },
          { cells: ['100.000', '~CHF 5.800', '~CHF 70.000', '~EUR 73.500'] },
          { cells: ['120.000', '~CHF 6.700', '~CHF 80.500', '~EUR 84.500'] },
        ],
        footnote: 'Schätzwerte für BVG-Altersband 25-34, Lugano. Ab 50+ steigt das BVG auf 18 % und das Netto sinkt um ~CHF 4.000/Jahr.',
      },
      faqs: [
        { q: 'Was ist das Schweizer RAL?', a: 'Bruttojahresgehalt: enthält je nach Branche 12 oder 13 Monatslöhne, jedoch keine Zusatzleistungen (Zusatzversicherung, Essensgutscheine, Parkplatz).' },
        { q: 'Zählen Arbeitgeberbeiträge?', a: 'Nicht im Netto, aber in der Gesamtvergütung: ~50 % BVG-Anteil plus Familien- und Unfallbeiträge.' },
        { q: 'Wie wirkt das Alter aufs Netto?', a: 'Stark: BVG steigt von 7 % (25-34) auf 18 % (55-65) und nimmt bei gleichem Brutto CHF 4-6k netto/Jahr weg.' },
      ],
    },
    fr: {
      eyebrow: 'Du brut suisse (RAL) au net réel',
      tagline: 'CHF 80 000 brut ≠ CHF 80 000 net : voyez ce qu\'il reste après AVS, LPP et impôt à la source.',
      tiles: [
        { label: 'Brut CHF 80k', value: '~CHF 58k net', tone: 'accent' },
        { label: 'Cotisations tot.', value: '14-22%', tone: 'warning' },
        { label: 'LPP 50+ ans', value: '+18%', tone: 'danger' },
        { label: '13e mois', value: 'Standard CH', tone: 'success' },
      ],
      advice: 'L\'écart réel Suisse vs Italie est 40-60 % plus grand que ne le suggère le brut — comparez les vrais nets avant de signer.',
      ctaPrimary: { label: 'Calculer le net depuis le brut', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer deux offres', href: '/fr/comparators/comparer-offres-emploi/' },
      table: {
        caption: 'Brut → net estimé (célibataire A0, Lugano)',
        headers: ['CHF brut', 'Net/mois', 'Net/an', 'Net en EUR'],
        rows: [
          { cells: ['60 000', '~CHF 4 000', '~CHF 48 000', '~EUR 50 000'] },
          { cells: ['80 000', '~CHF 4 800', '~CHF 58 000', '~EUR 60 500'], emphasized: true },
          { cells: ['100 000', '~CHF 5 800', '~CHF 70 000', '~EUR 73 500'] },
          { cells: ['120 000', '~CHF 6 700', '~CHF 80 500', '~EUR 84 500'] },
        ],
        footnote: 'Estimations pour LPP 25-34, Lugano. Dès 50 ans, la LPP atteint 18 % et le net baisse de ~CHF 4 000/an.',
      },
      faqs: [
        { q: 'Qu\'est-ce que le RAL suisse exactement ?', a: 'Salaire annuel brut : inclut 12 ou 13 mensualités selon le secteur, mais pas les avantages (assurance complémentaire, chèques repas, parking).' },
        { q: 'Les cotisations patronales comptent-elles ?', a: 'Pas dans le net, mais oui dans la "rémunération totale" : l\'employeur verse ~50 % de la LPP plus cotisations famille/accident.' },
        { q: 'Comment l\'âge impacte le net ?', a: 'Beaucoup : la LPP passe de 7 % (25-34) à 18 % (55-65) et retire CHF 4-6k nets/an à brut égal.' },
      ],
    },
  },

  // ── IT-only orphan hubs (URL exists only in IT sitemap-pages.xml) ─────────

  'simula-cambio-residenza': {
    it: {
      eyebrow: 'Simulatore residenza · Frontaliere',
      tagline: 'Stima il delta netto annuo se ti trasferisci in Svizzera (permesso B) o resti in Italia (permesso G).',
      tiles: [
        { label: 'Permit G → B', value: '+CHF 3-7k/anno', tone: 'success' },
        { label: 'Costo LAMal', value: '200-600 CHF/mese', tone: 'warning' },
        { label: 'Soggiorno richiesto', value: '>183 gg/anno CH', tone: 'accent' },
        { label: 'Cassa malati', value: 'LAMal obbligatoria', tone: 'danger' },
      ],
      advice: 'Il cambio residenza CH conviene sopra CHF 80k di RAL: il risparmio fiscale supera i costi extra (affitto Lugano, LAMal). Verifica disponibilità abitativa prima di firmare.',
      ctaPrimary: { label: 'Apri il simulatore', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronto permesso G vs B', href: '/calcola-stipendio/confronto-permesso-g-vs-b-entro-20km/' },
      table: {
        caption: 'Delta netto annuo · trasferimento da Italia a Svizzera (single, A0N)',
        headers: ['RAL CHF', 'Permit G (Italia)', 'Permit B (CH)', 'Δ a favore B'],
        rows: [
          { cells: ['60.000', '~CHF 44.000', '~CHF 45.500', '+CHF 1.500'] },
          { cells: ['80.000', '~CHF 55.000', '~CHF 58.000', '+CHF 3.000'], emphasized: true },
          { cells: ['100.000', '~CHF 67.000', '~CHF 71.000', '+CHF 4.000'] },
        ],
        footnote: 'Stime al netto di trasporto frontaliere (G) e LAMal CHF 4.800/anno (B). Considera anche costo affitto Lugano (~+CHF 1.200/mese vs Como).',
      },
      faqs: [
        { q: 'Quali sono i requisiti per il permesso B?', a: 'Contratto di lavoro CH valido, alloggio a tuo nome, dimostrazione di mezzi sufficienti, iscrizione anagrafica al Comune CH (entro 14 giorni dall\'arrivo). Variabile per cantone.' },
        { q: 'Cosa cambia nella mia tassazione cambiando residenza?', a: 'Passi dal regime frontaliere (tassazione concorrente CH+IT) a residente CH (solo tassazione svizzera). Risparmi tipicamente CHF 3-7k/anno ma assumi LAMal obbligatoria.' },
        { q: 'Posso mantenere casa in Italia?', a: 'Sì, ma il fisco italiano potrebbe contestare la residenza fiscale: serve dimostrare che il centro vitale è in CH (>183 gg/anno, contratto, conti bancari, vita sociale).' },
      ],
    },
  },

  'stima-bonus-frontaliere': {
    it: {
      eyebrow: 'Bonus & 13ª · Frontaliere Ticino',
      tagline: 'Stima il valore reale del bonus annuo + 13ª mensilità nel tuo netto, dopo tasse e contributi.',
      tiles: [
        { label: '13ª obbligatoria', value: 'Standard CCL', tone: 'success' },
        { label: 'Tassazione bonus', value: 'Stessa fonte', tone: 'warning' },
        { label: 'Trattenuta CH', value: '~25-30% del lordo', tone: 'danger' },
        { label: 'Netto in tasca', value: '~70-75%', tone: 'accent' },
      ],
      advice: 'Un bonus lordo di CHF 10.000 vale ~CHF 7.200 netti in tasca (single A0). Il datore può ottimizzare versandolo come pilastro 3a se non hai ancora raggiunto il tetto annuo deducibile.',
      ctaPrimary: { label: 'Calcola il netto con bonus', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Cosa cambia se… (what-if)', href: '/calcola-stipendio/cosa-cambia-se/' },
      table: {
        caption: 'Netto stimato di un bonus annuo CHF 10.000 (Lugano, A0N)',
        headers: ['Voce', 'Importo lordo', 'Trattenute', 'Netto in tasca'],
        rows: [
          { cells: ['Bonus puro', 'CHF 10.000', '-CHF 2.800', 'CHF 7.200'], emphasized: true },
          { cells: ['Bonus → pilastro 3a', 'CHF 10.000', '-CHF 0 (deducibile)', 'CHF 10.000 in pensione'] },
          { cells: ['13ª su lordo 80k', 'CHF 6.150', '-CHF 1.720', 'CHF 4.430'] },
        ],
        footnote: 'Versare bonus al pilastro 3a azzera la tassazione immediata fino al massimo deducibile annuo (CHF 7.258 nel 2026 per affiliati LPP).',
      },
      faqs: [
        { q: 'La 13ª è obbligatoria?', a: 'Dipende dal CCL settoriale. In Ticino la maggior parte dei settori la prevede (industria, banche, sanità, retail). Verifica sempre il contratto firmato.' },
        { q: 'Posso versare il bonus al pilastro 3a?', a: 'Sì, se non hai ancora raggiunto il massimo deducibile annuo. Versando CHF 7.258 al pilastro 3a deduci l\'intero importo dal reddito imponibile.' },
        { q: 'Bonus target e variable: come si tassano?', a: 'Esattamente come il salario fisso, all\'imposta alla fonte cantonale + contributi sociali. Non c\'è regime agevolato in Svizzera.' },
      ],
    },
  },

  'verifica-congedo-parentale': {
    it: {
      eyebrow: 'Congedo parentale · Frontaliere',
      tagline: 'Diritti, durata e indennità del congedo parentale per frontaliere: cosa offre la Svizzera vs l\'Italia.',
      tiles: [
        { label: 'Maternità CH', value: '14 settimane (80%)', tone: 'accent' },
        { label: 'Paternità CH', value: '2 settimane (80%)', tone: 'accent' },
        { label: 'Maternità IT', value: '5 mesi (80%)', tone: 'success' },
        { label: 'Frontaliere applica', value: 'Legge svizzera', tone: 'warning' },
      ],
      advice: 'Il frontaliere segue la legge svizzera: 14 settimane di maternità (80% salario) + 2 settimane di paternità. Per congedi più lunghi serve trattativa col datore o aspettare il rientro definitivo in IT.',
      ctaPrimary: { label: 'Calcola impatto netto', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Cosa cambia se… (figli)', href: '/calcola-stipendio/cosa-cambia-se/' },
      table: {
        caption: 'Congedo parentale: Svizzera (frontaliere) vs Italia',
        headers: ['Voce', 'Svizzera (frontaliere)', 'Italia (residente)'],
        rows: [
          { cells: ['Maternità', '14 settimane × 80%', '5 mesi × 80%'], emphasized: true },
          { cells: ['Paternità', '2 settimane × 80%', '10 giorni × 100%'] },
          { cells: ['Parentale aggiuntivo', 'No (solo trattativa)', '6 mesi × 30%'] },
          { cells: ['Tetto giornaliero', 'CHF 220/giorno', '~EUR 100/giorno'] },
        ],
        footnote: 'Il frontaliere applica la legge svizzera (Loi sur les allocations pour perte de gain — LAPG). Verifica eventuali CCL settoriali per condizioni migliorative.',
      },
      faqs: [
        { q: 'Posso usare il congedo parentale italiano se sono frontaliere?', a: 'No. Il frontaliere è assicurato in Svizzera (LAPG) e segue le regole svizzere: 14 settimane di maternità + 2 di paternità con tetto giornaliero CHF 220.' },
        { q: 'Come cambia il netto durante il congedo?', a: 'Ricevi l\'80% del salario fino al tetto CHF 220/giorno. Per stipendi sopra CHF 88.000/anno c\'è un taglio: usa il simulatore per stimare il netto durante il periodo.' },
        { q: 'Posso chiedere parental leave non retribuito?', a: 'Sì, ma dipende dal CCL e dal contratto. Senza obbligo legale, è una trattativa col datore. Alcune aziende offrono fino a 6 mesi non retribuiti su richiesta.' },
      ],
    },
  },
};

// ── Salary-tier generator ───────────────────────────────────────────────────
//
// Covers the 19 SALARY_LANDING_EDITORIAL paths plus the 5 net-comparison
// landings in router.ts. Net estimates use simple deterministic formulas so
// the table reflects a coherent scenario without per-page hand-tuning.

type TierVariant =
  | 'base'
  | 'new'      // nuovo frontaliere 2026
  | 'old'      // vecchio frontaliere
  | 'married'  // sposato + 2 figli
  | 'within20' // residenza entro 20 km
  | 'over20';  // residenza oltre 20 km

interface TierConfig {
  readonly ral: number; // CHF thousand
  readonly variant: TierVariant;
}

const SALARY_TIER_LABELS: Record<SalaryLocale, {
  eyebrow: string;
  taglinePrefix: string;
  netTile: string;
  fonteTile: string;
  irpefTile: string;
  tableLabel: string;
  fxLabel: string;
  rateTile: string;
  adviceTpl: (gross: number, net: number) => string;
  tableCaption: (gross: number) => string;
  th: ReadonlyArray<string>;
  rowLabels: { gross: string; social: string; source: string; italian: string; net: string };
  footnote: string;
  faqQ1: string; faqA1: (gross: number) => string;
  faqQ2: string; faqA2: string;
  faqQ3: string; faqA3: string;
  variantSuffix: Record<TierVariant, string>;
}> = {
  it: {
    eyebrow: 'Simulazione netto · Frontaliere Ticino 2026',
    taglinePrefix: 'Calcolo dettagliato del netto su una RAL di',
    netTile: 'Netto annuo',
    fonteTile: 'Fonte cantonale',
    irpefTile: 'Franchigia IT',
    tableLabel: 'Tabella A · B · C',
    fxLabel: 'BNS giornaliero',
    rateTile: 'Cambio CHF/EUR',
    adviceTpl: (g, n) => `Su CHF ${g.toLocaleString('it-CH')} di lordo, ti restano circa CHF ${n.toLocaleString('it-CH')} netti — equivalenti a EUR ${Math.round(n * 1.05).toLocaleString('it-CH')} al cambio del giorno.`,
    tableCaption: (g) => `Decomposizione: RAL CHF ${g.toLocaleString('it-CH')} (single A0, Lugano)`,
    th: ['Voce', 'Importo annuo (CHF)', 'Importo annuo (EUR)'],
    rowLabels: { gross: 'Lordo (RAL)', social: 'Contributi sociali', source: 'Imposta alla fonte TI', italian: 'IRPEF residua (post-franchigia)', net: 'Netto stimato' },
    footnote: 'Stima per scopi indicativi. Per il tuo caso esatto usa il simulatore con i tuoi parametri.',
    faqQ1: 'Come si calcola il netto da questa RAL?',
    faqA1: (g) => `Da CHF ${g.toLocaleString('it-CH')} lordi si sottraggono prima i contributi sociali (~14-16%), poi l'imposta alla fonte Ticino, infine l'IRPEF italiana residua post-franchigia 10.000 EUR.`,
    faqQ2: 'Quanto incide la fascia LPP?',
    faqA2: 'Tanto: il LPP varia dal 7% (25-34 anni) al 18% (55-65 anni) del salario coordinato. Un over-50 con lo stesso lordo prende ~CHF 4.000/anno netti in meno.',
    faqQ3: 'Il netto è in CHF o EUR?',
    faqA3: 'Il simulatore mostra entrambi: CHF per la busta paga, EUR convertito al cambio BNS del giorno per pianificare le spese in Italia.',
    variantSuffix: {
      base: '',
      new: ' · Nuovo frontaliere 2026',
      old: ' · Vecchio frontaliere',
      married: ' · Sposato 2 figli',
      within20: ' · Entro 20 km',
      over20: ' · Oltre 20 km',
    },
  },
  en: {
    eyebrow: 'Net simulation · Ticino cross-border 2026',
    taglinePrefix: 'Detailed net calculation on a gross of',
    netTile: 'Annual net',
    fonteTile: 'Cantonal source',
    irpefTile: 'IT allowance',
    tableLabel: 'Table A · B · C',
    fxLabel: 'SNB daily',
    rateTile: 'CHF/EUR rate',
    adviceTpl: (g, n) => `On CHF ${g.toLocaleString('en-US')} gross, about CHF ${n.toLocaleString('en-US')} net remains — equivalent to EUR ${Math.round(n * 1.05).toLocaleString('en-US')} at the daily rate.`,
    tableCaption: (g) => `Breakdown: gross CHF ${g.toLocaleString('en-US')} (single A0, Lugano)`,
    th: ['Line', 'Annual amount (CHF)', 'Annual amount (EUR)'],
    rowLabels: { gross: 'Gross (RAL)', social: 'Social contributions', source: 'Ticino source tax', italian: 'Residual IRPEF (post-allowance)', net: 'Estimated net' },
    footnote: 'Indicative estimate. For your exact case use the simulator with your parameters.',
    faqQ1: 'How is the net calculated from this gross?',
    faqA1: (g) => `From CHF ${g.toLocaleString('en-US')} gross we first subtract social contributions (~14-16%), then Ticino source tax, then residual Italian IRPEF after the EUR 10,000 allowance.`,
    faqQ2: 'How much does the LPP bracket matter?',
    faqA2: 'A lot: LPP ranges from 7% (age 25-34) to 18% (age 55-65) of the coordinated salary. An over-50 worker with the same gross takes home ~CHF 4,000/year less.',
    faqQ3: 'Is the net in CHF or EUR?',
    faqA3: 'The simulator shows both: CHF for the payslip, EUR converted at the daily SNB rate so you can plan Italian expenses.',
    variantSuffix: {
      base: '',
      new: ' · New 2026 cross-border worker',
      old: ' · Existing cross-border worker',
      married: ' · Married, 2 children',
      within20: ' · Within 20 km',
      over20: ' · Over 20 km',
    },
  },
  de: {
    eyebrow: 'Netto-Simulation · Grenzgänger Tessin 2026',
    taglinePrefix: 'Detaillierte Nettoberechnung auf einem Brutto von',
    netTile: 'Jahresnetto',
    fonteTile: 'Kantonale Quelle',
    irpefTile: 'IT-Freibetrag',
    tableLabel: 'Tabelle A · B · C',
    fxLabel: 'SNB-Tageskurs',
    rateTile: 'CHF/EUR-Kurs',
    adviceTpl: (g, n) => `Bei CHF ${g.toLocaleString('de-CH')} brutto bleiben rund CHF ${n.toLocaleString('de-CH')} netto — entspricht EUR ${Math.round(n * 1.05).toLocaleString('de-CH')} zum Tageskurs.`,
    tableCaption: (g) => `Aufschlüsselung: Brutto CHF ${g.toLocaleString('de-CH')} (ledig A0, Lugano)`,
    th: ['Position', 'Jahresbetrag (CHF)', 'Jahresbetrag (EUR)'],
    rowLabels: { gross: 'Brutto (RAL)', social: 'Sozialabgaben', source: 'Tessiner Quellensteuer', italian: 'IRPEF-Rest (nach Freibetrag)', net: 'Geschätztes Netto' },
    footnote: 'Richtwert. Für Ihren konkreten Fall den Simulator mit Ihren Parametern nutzen.',
    faqQ1: 'Wie wird das Netto aus diesem Brutto berechnet?',
    faqA1: (g) => `Von CHF ${g.toLocaleString('de-CH')} brutto werden zuerst Sozialabgaben (~14-16 %) abgezogen, dann die Tessiner Quellensteuer, dann die italienische IRPEF nach EUR 10.000 Freibetrag.`,
    faqQ2: 'Wie stark wirkt die BVG-Altersgruppe?',
    faqA2: 'Stark: BVG reicht von 7 % (25-34) bis 18 % (55-65) des koordinierten Lohns. Ein Über-50 mit gleichem Brutto erhält ~CHF 4.000/Jahr weniger netto.',
    faqQ3: 'Ist das Netto in CHF oder EUR?',
    faqA3: 'Der Simulator zeigt beides: CHF für den Lohnausweis, EUR zum SNB-Tageskurs zur Planung italienischer Ausgaben.',
    variantSuffix: {
      base: '',
      new: ' · Neuer Grenzgänger 2026',
      old: ' · Alter Grenzgänger',
      married: ' · Verheiratet, 2 Kinder',
      within20: ' · Bis 20 km',
      over20: ' · Über 20 km',
    },
  },
  fr: {
    eyebrow: 'Simulation net · Frontalier Tessin 2026',
    taglinePrefix: 'Calcul détaillé du net sur un brut de',
    netTile: 'Net annuel',
    fonteTile: 'Source cantonale',
    irpefTile: 'Franchise IT',
    tableLabel: 'Barème A · B · C',
    fxLabel: 'BNS quotidien',
    rateTile: 'Taux CHF/EUR',
    adviceTpl: (g, n) => `Sur CHF ${g.toLocaleString('fr-CH')} brut, il reste ~CHF ${n.toLocaleString('fr-CH')} nets — soit EUR ${Math.round(n * 1.05).toLocaleString('fr-CH')} au taux du jour.`,
    tableCaption: (g) => `Décomposition : brut CHF ${g.toLocaleString('fr-CH')} (célibataire A0, Lugano)`,
    th: ['Poste', 'Montant annuel (CHF)', 'Montant annuel (EUR)'],
    rowLabels: { gross: 'Brut (RAL)', social: 'Cotisations sociales', source: 'Impôt à la source TI', italian: 'IRPEF résiduel (post-franchise)', net: 'Net estimé' },
    footnote: 'Estimation indicative. Pour votre cas exact, utilisez le simulateur avec vos paramètres.',
    faqQ1: 'Comment se calcule le net depuis ce brut ?',
    faqA1: (g) => `De CHF ${g.toLocaleString('fr-CH')} brut on déduit d\'abord les cotisations sociales (~14-16 %), puis l\'impôt à la source du Tessin, puis l\'IRPEF italien résiduel après la franchise EUR 10 000.`,
    faqQ2: 'Combien impacte la tranche LPP ?',
    faqA2: 'Beaucoup : la LPP va de 7 % (25-34 ans) à 18 % (55-65 ans) du salaire coordonné. Un 50+ avec le même brut touche ~CHF 4 000/an de moins.',
    faqQ3: 'Le net est en CHF ou EUR ?',
    faqA3: 'Le simulateur affiche les deux : CHF pour la fiche de paie, EUR converti au taux BNS du jour pour planifier les dépenses en Italie.',
    variantSuffix: {
      base: '',
      new: ' · Nouveau frontalier 2026',
      old: ' · Ancien frontalier',
      married: ' · Marié, 2 enfants',
      within20: ' · Moins 20 km',
      over20: ' · Plus 20 km',
    },
  },
};

/**
 * Apply variant-specific adjustments to the base-case net estimate.
 * Numbers are coherent illustrative deltas, not authoritative tax results.
 */
function adjustNetForVariant(baseNet: number, variant: TierVariant): number {
  switch (variant) {
    case 'new':      return baseNet - 800;   // new regime + Italian IRPEF residual
    case 'old':      return baseNet + 1200;  // grandfathered, no IT IRPEF
    case 'married':  return baseNet + 2800;  // table C2 lower withholding
    case 'within20': return baseNet + 1500;  // 80/20 split + IT credit
    case 'over20':   return baseNet - 1500;  // 100% Swiss withholding
    case 'base':
    default:         return baseNet;
  }
}

/**
 * Build SalaryLandingData for a salary-tier scenario (e.g. CHF 80k base,
 * CHF 100k married, CHF 60k over-20km). All numbers are derived from
 * `ral` × `variant` so the family stays internally consistent.
 */
function buildSalaryTierData(cfg: TierConfig, locale: SalaryLocale): SalaryLandingData {
  const labels = SALARY_TIER_LABELS[locale];
  const pack = LOCALE_PACKS[locale];
  const grossCHF = cfg.ral * 1000;
  // Coherent estimate: social ~15%, source ~12% of remainder, IRPEF residual small.
  const social = Math.round(grossCHF * 0.15);
  const sourceTax = Math.round((grossCHF - social) * 0.12);
  const baseNet = grossCHF - social - sourceTax;
  const adjusted = adjustNetForVariant(baseNet, cfg.variant);
  const netCHF = adjusted;
  const netEUR = Math.round(netCHF * 1.05);
  const italianResidualEUR = cfg.variant === 'old' ? 0 : Math.max(0, Math.round((grossCHF * 1.05 - 10000) * 0.04));

  return {
    eyebrow: `${labels.eyebrow}${labels.variantSuffix[cfg.variant]}`,
    tagline: `${labels.taglinePrefix} CHF ${grossCHF.toLocaleString(locale === 'en' ? 'en-US' : locale === 'fr' ? 'fr-CH' : 'de-CH')}.`,
    tiles: [
      { label: labels.netTile, value: `~CHF ${netCHF.toLocaleString(locale === 'en' ? 'en-US' : 'de-CH')}`, tone: 'accent' },
      { label: labels.fonteTile, value: labels.tableLabel, tone: 'success' },
      { label: labels.irpefTile, value: 'EUR 10.000', tone: 'warning' },
      { label: labels.rateTile, value: labels.fxLabel, tone: 'neutral' },
    ],
    advice: labels.adviceTpl(grossCHF, netCHF),
    ctaPrimary: { label: pack.ctaPrimary, href: pack.simulatorHref },
    ctaSecondary: { label: pack.ctaSecondary, href: pack.whatIfHref },
    table: {
      caption: labels.tableCaption(grossCHF),
      headers: labels.th,
      rows: [
        { cells: [labels.rowLabels.gross, grossCHF.toLocaleString('de-CH'), `~${Math.round(grossCHF * 1.05).toLocaleString('de-CH')}`] },
        { cells: [labels.rowLabels.social, `-${social.toLocaleString('de-CH')}`, `-${Math.round(social * 1.05).toLocaleString('de-CH')}`] },
        { cells: [labels.rowLabels.source, `-${sourceTax.toLocaleString('de-CH')}`, `-${Math.round(sourceTax * 1.05).toLocaleString('de-CH')}`] },
        { cells: [labels.rowLabels.italian, '—', italianResidualEUR > 0 ? `-${italianResidualEUR.toLocaleString('de-CH')}` : '0'] },
        { cells: [labels.rowLabels.net, netCHF.toLocaleString('de-CH'), `~${netEUR.toLocaleString('de-CH')}`], emphasized: true },
      ],
      footnote: labels.footnote,
    },
    faqs: [
      { q: labels.faqQ1, a: labels.faqA1(grossCHF) },
      { q: labels.faqQ2, a: labels.faqA2 },
      { q: labels.faqQ3, a: labels.faqA3 },
    ],
  };
}

// ── URL → scenario resolver ─────────────────────────────────────────────────
//
// Maps any canonical path (any locale) to (scenarioKey, locale). Salary-tier
// paths return both a key and the parsed `ral` + `variant` so the caller
// can hand them to the generator. Hub paths return only the key + locale.

// Per live `sitemap-pages.xml`, all hub URLs under /calcola-stipendio/* are
// IT-only. EN/DE/FR siblings are not emitted by the static-pages plugin
// (the salaryHub plugin owns the salary-tier slugs in all 4 locales — see
// `salaryHubContent.generatePageHtml` which already handles its own
// localisation). Adding EN/DE/FR keys here is dead code.
const HUB_PATH_TO_KEY: Record<string, { key: HubKey; locale: SalaryLocale }> = {
  '/calcola-stipendio/nuovi-frontalieri-oltre-20-km': { key: 'nuovi-frontalieri-oltre-20-km', locale: 'it' },
  '/calcola-stipendio/simula-busta-paga': { key: 'simula-busta-paga', locale: 'it' },
  '/calcola-stipendio/cosa-cambia-se': { key: 'cosa-cambia-se', locale: 'it' },
  '/calcola-stipendio/confronta-retribuzione-ral': { key: 'confronta-retribuzione-ral', locale: 'it' },
  // Quiz: live slug is `quanto-guadagneresti-in-svizzera`, not `quiz-stipendio`.
  '/calcola-stipendio/quanto-guadagneresti-in-svizzera': { key: 'quanto-guadagneresti-in-svizzera', locale: 'it' },
  // 3 hubs missed by the previous round (all IT-only, all in sitemap-pages.xml).
  '/calcola-stipendio/simula-cambio-residenza': { key: 'simula-cambio-residenza', locale: 'it' },
  '/calcola-stipendio/stima-bonus-frontaliere': { key: 'stima-bonus-frontaliere', locale: 'it' },
  '/calcola-stipendio/verifica-congedo-parentale': { key: 'verifica-congedo-parentale', locale: 'it' },
};

/**
 * Parse a salary-tier slug across the 4 locales.
 *
 * Patterns matched (per locale):
 *   IT: stipendio-netto-{60000|80000|100000|120000}-chf[-{variant}]
 *   EN: net-salary-{...}-chf[-{variant}]
 *   DE: nettogehalt-{...}-chf[-{variant}]
 *   FR: salaire-net-{...}-chf[-{variant}]
 *
 * Variant suffixes (IT examples): nuovo-frontaliere-2026, vecchio-frontaliere,
 * sposato-2-figli, residenza-entro-20km, residenza-oltre-20km.
 */
function parseSalaryTierPath(canonicalPath: string): { ral: number; variant: TierVariant; locale: SalaryLocale } | null {
  const stripped = canonicalPath.replace(/\/+$/, '');
  // Locale + tier pattern: keep loose, support all 4 slug families.
  const patterns: ReadonlyArray<{ regex: RegExp; locale: SalaryLocale }> = [
    { regex: /^\/calcola-stipendio\/stipendio-netto-(\d+)-chf(-.+)?$/, locale: 'it' },
    { regex: /^\/en\/calculate-salary\/net-salary-(\d+)-chf(-.+)?$/, locale: 'en' },
    { regex: /^\/de\/gehalt-berechnen\/nettogehalt-(\d+)-chf(-.+)?$/, locale: 'de' },
    { regex: /^\/fr\/calculer-salaire\/salaire-net-(\d+)-chf(-.+)?$/, locale: 'fr' },
  ];
  for (const { regex, locale } of patterns) {
    const m = stripped.match(regex);
    if (!m) continue;
    const ral = Math.round(Number(m[1]) / 1000);
    if (![40, 60, 80, 100, 120].includes(ral)) return null;
    const suffix = (m[2] || '').toLowerCase();
    let variant: TierVariant = 'base';
    if (/nuovo|new-cross|neuer|nouveau/.test(suffix)) variant = 'new';
    else if (/vecchio|old-cross|alter|ancien/.test(suffix)) variant = 'old';
    else if (/sposato|married|verheiratet|marie/.test(suffix)) variant = 'married';
    else if (/entro-20|within-20|bis-20|moins-20/.test(suffix)) variant = 'within20';
    else if (/oltre-20|over-20|ueber-20|plus-20/.test(suffix)) variant = 'over20';
    return { ral, variant, locale };
  }
  return null;
}

/**
 * Locale detection for non-tier paths (hub miss + URL prefix).
 */
function detectLocale(canonicalPath: string): SalaryLocale {
  if (canonicalPath.startsWith('/en/')) return 'en';
  if (canonicalPath.startsWith('/de/')) return 'de';
  if (canonicalPath.startsWith('/fr/')) return 'fr';
  return 'it';
}

// ── Net-comparison scenarios (4 paths × 4 locales) ──────────────────────────
//
// These pages compare two regimes side-by-side: 2025 (old / grandfathered)
// vs 2026 (new agreement) for both 20km distance bands, OR Permit G vs
// Permit B for both bands. Table layout is "voce | A | B | Δ" rather than
// the salary-tier decomposition.

type NetComparisonKey =
  | 'confronto-netto-2025-2026-entro-20km'
  | 'confronto-netto-2025-2026-oltre-20km'
  | 'confronto-permesso-g-vs-b-entro-20km'
  | 'confronto-permesso-g-vs-b-oltre-20km';

const NET_COMPARISON_SCENARIOS: Record<NetComparisonKey, Record<SalaryLocale, SalaryLandingData>> = {
  'confronto-netto-2025-2026-entro-20km': {
    it: {
      eyebrow: 'Confronto regime · Entro 20 km',
      tagline: 'Vecchio regime (pre-2024) vs Nuovo Accordo 2026 a parità di lordo, residenza entro 20 km.',
      tiles: [
        { label: 'Vecchio regime', value: '100% CH + rimborso 40%', tone: 'success' },
        { label: 'Nuovo regime', value: '80% CH / 20% IT', tone: 'accent' },
        { label: 'Delta netto', value: '€0 - 1.500/anno', tone: 'warning' },
        { label: 'Transizione', value: 'fino al 2033', tone: 'neutral' },
      ],
      advice: 'Se sei vecchio frontaliere ed entro 20 km, il delta è minimo (~€500/anno). Se sei nuovo, il netto può scendere di €1.000-1.500/anno per l\'IRPEF residua.',
      ctaPrimary: { label: 'Calcola il tuo netto 2026', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Vedi scenari what-if', href: '/calcola-stipendio/cosa-cambia-se/' },
      table: {
        caption: 'Netto annuo entro 20 km · vecchio vs nuovo regime (A0N, Lugano)',
        headers: ['Voce', 'Vecchio regime 2025', 'Nuovo regime 2026', 'Δ EUR/anno'],
        rows: [
          { cells: ['RAL CHF 60.000', '~EUR 47.000', '~EUR 46.500', '-500'] },
          { cells: ['RAL CHF 80.000', '~EUR 59.500', '~EUR 58.000', '-1.500'], emphasized: true },
          { cells: ['RAL CHF 100.000', '~EUR 71.500', '~EUR 70.000', '-1.500'] },
        ],
        footnote: 'Stime indicative. I "vecchi frontalieri" (assunti ante 17.07.2023) mantengono il regime 2025 fino al pensionamento.',
      },
      faqs: [
        { q: 'Chi resta nel vecchio regime?', a: 'Chi era già frontaliere assunto prima del 17.07.2023. Il vecchio regime è grandfathered fino al pensionamento (massimo 2033 per la fase transitoria).' },
        { q: 'Devo fare la dichiarazione in Italia con il nuovo regime?', a: 'Sì: i nuovi frontalieri (anche entro 20 km) devono dichiarare il reddito svizzero in Italia con il quadro CE e ottenere il credito per l\'imposta CH già pagata.' },
        { q: 'Conviene chiedere di essere "vecchio frontaliere"?', a: 'Non è una scelta: lo status dipende dalla data di assunzione. Se sei stato assunto ante 17.07.2023, lo sei automaticamente.' },
      ],
    },
    en: {
      eyebrow: 'Regime comparison · Within 20 km',
      tagline: 'Old regime (pre-2024) vs New Agreement 2026 at the same gross, residence within 20 km.',
      tiles: [
        { label: 'Old regime', value: '100% CH + 40% rebate', tone: 'success' },
        { label: 'New regime', value: '80% CH / 20% IT', tone: 'accent' },
        { label: 'Net delta', value: '€0 - 1,500/year', tone: 'warning' },
        { label: 'Transition until', value: '2033', tone: 'neutral' },
      ],
      advice: 'If you are a grandfathered cross-border worker within 20 km, the delta is minimal (~€500/year). For new workers, net can drop by €1,000-1,500/year due to residual IRPEF.',
      ctaPrimary: { label: 'Calculate your 2026 net', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'See what-if scenarios', href: '/en/calculate-salary/what-if/' },
      table: {
        caption: 'Annual net within 20 km · old vs new regime (A0N, Lugano)',
        headers: ['Line', 'Old regime 2025', 'New regime 2026', 'Δ EUR/year'],
        rows: [
          { cells: ['Gross CHF 60,000', '~EUR 47,000', '~EUR 46,500', '-500'] },
          { cells: ['Gross CHF 80,000', '~EUR 59,500', '~EUR 58,000', '-1,500'], emphasized: true },
          { cells: ['Gross CHF 100,000', '~EUR 71,500', '~EUR 70,000', '-1,500'] },
        ],
        footnote: 'Indicative estimates. Grandfathered cross-border workers (hired before 17 Jul 2023) keep the 2025 regime until retirement.',
      },
      faqs: [
        { q: 'Who stays under the old regime?', a: 'Anyone hired as a cross-border worker before 17 Jul 2023. The old regime is grandfathered until retirement (transitional phase up to 2033).' },
        { q: 'Do I need an Italian tax return under the new regime?', a: 'Yes: new workers (even within 20 km) must declare Swiss income in Italy via the CE schedule and claim credit for Swiss tax already paid.' },
        { q: 'Can I ask to be grandfathered?', a: 'No, status depends on hire date. If hired before 17 Jul 2023 you are grandfathered automatically.' },
      ],
    },
    de: {
      eyebrow: 'Regime-Vergleich · Bis 20 km',
      tagline: 'Altes Regime (vor 2024) vs. Neues Abkommen 2026 bei gleichem Brutto, Wohnsitz bis 20 km.',
      tiles: [
        { label: 'Altes Regime', value: '100% CH + 40% Rückerstattung', tone: 'success' },
        { label: 'Neues Regime', value: '80% CH / 20% IT', tone: 'accent' },
        { label: 'Netto-Differenz', value: '€0 - 1.500/Jahr', tone: 'warning' },
        { label: 'Übergangsphase bis', value: '2033', tone: 'neutral' },
      ],
      advice: 'Alte Grenzgänger bis 20 km haben eine minimale Differenz (~€500/Jahr). Neue Grenzgänger sehen das Netto um €1.000-1.500/Jahr sinken wegen IRPEF-Rest.',
      ctaPrimary: { label: 'Netto 2026 berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Was-wäre-wenn-Szenarien', href: '/de/gehalt-berechnen/was-waere-wenn/' },
      table: {
        caption: 'Jahresnetto bis 20 km · altes vs. neues Regime (A0N, Lugano)',
        headers: ['Position', 'Altes Regime 2025', 'Neues Regime 2026', 'Δ EUR/Jahr'],
        rows: [
          { cells: ['Brutto CHF 60.000', '~EUR 47.000', '~EUR 46.500', '-500'] },
          { cells: ['Brutto CHF 80.000', '~EUR 59.500', '~EUR 58.000', '-1.500'], emphasized: true },
          { cells: ['Brutto CHF 100.000', '~EUR 71.500', '~EUR 70.000', '-1.500'] },
        ],
        footnote: 'Richtwerte. Alte Grenzgänger (vor 17.07.2023 angestellt) behalten das Regime 2025 bis zur Pension.',
      },
      faqs: [
        { q: 'Wer fällt unter das alte Regime?', a: 'Wer vor dem 17.07.2023 als Grenzgänger angestellt wurde. Grandfathering bis zur Pension (Übergangsphase bis 2033).' },
        { q: 'Italienische Steuererklärung im neuen Regime?', a: 'Ja: Neue Grenzgänger (auch bis 20 km) müssen das Schweizer Einkommen in Italien via CE-Vordruck erklären und das Guthaben für die Schweizer Quellensteuer anrechnen.' },
        { q: 'Kann ich um Grandfathering bitten?', a: 'Nein, der Status hängt vom Einstellungsdatum ab. Bei Anstellung vor 17.07.2023 automatisch.' },
      ],
    },
    fr: {
      eyebrow: 'Comparaison régimes · Moins 20 km',
      tagline: 'Ancien régime (pré-2024) vs Nouvel Accord 2026 à brut égal, résidence à moins de 20 km.',
      tiles: [
        { label: 'Ancien régime', value: '100% CH + ristourne 40%', tone: 'success' },
        { label: 'Nouveau régime', value: '80% CH / 20% IT', tone: 'accent' },
        { label: 'Delta net', value: '€0 - 1 500/an', tone: 'warning' },
        { label: 'Transition jusqu\'à', value: '2033', tone: 'neutral' },
      ],
      advice: 'Si vous êtes ancien frontalier à moins de 20 km, le delta est minime (~€500/an). Pour les nouveaux, le net peut baisser de €1 000-1 500/an à cause de l\'IRPEF résiduel.',
      ctaPrimary: { label: 'Calculer votre net 2026', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Voir scénarios et-si', href: '/fr/calculer-salaire/et-si/' },
      table: {
        caption: 'Net annuel moins 20 km · ancien vs nouveau régime (A0N, Lugano)',
        headers: ['Poste', 'Ancien régime 2025', 'Nouveau régime 2026', 'Δ EUR/an'],
        rows: [
          { cells: ['Brut CHF 60 000', '~EUR 47 000', '~EUR 46 500', '-500'] },
          { cells: ['Brut CHF 80 000', '~EUR 59 500', '~EUR 58 000', '-1 500'], emphasized: true },
          { cells: ['Brut CHF 100 000', '~EUR 71 500', '~EUR 70 000', '-1 500'] },
        ],
        footnote: 'Estimations indicatives. Les anciens frontaliers (embauchés avant le 17.07.2023) gardent le régime 2025 jusqu\'à la retraite.',
      },
      faqs: [
        { q: 'Qui reste dans l\'ancien régime ?', a: 'Toute personne embauchée comme frontalier avant le 17 juillet 2023. Maintien jusqu\'à la retraite (phase transitoire jusqu\'en 2033).' },
        { q: 'Faut-il déclarer en Italie sous le nouveau régime ?', a: 'Oui : les nouveaux frontaliers (même à moins de 20 km) doivent déclarer le revenu suisse en Italie via le quadro CE et obtenir le crédit pour l\'impôt CH déjà payé.' },
        { q: 'Puis-je demander à rester dans l\'ancien régime ?', a: 'Non, le statut dépend de la date d\'embauche. Avant le 17 juillet 2023 = ancien frontalier automatiquement.' },
      ],
    },
  },

  'confronto-netto-2025-2026-oltre-20km': {
    it: {
      eyebrow: 'Confronto regime · Oltre 20 km',
      tagline: 'Vecchio regime vs Nuovo Accordo 2026: per chi vive oltre 20 km, il delta è significativo.',
      tiles: [
        { label: 'Vecchio regime', value: 'Raramente applicabile', tone: 'neutral' },
        { label: 'Nuovo regime', value: '100% CH + IRPEF IT', tone: 'danger' },
        { label: 'Delta netto', value: '-€2.000 - 4.000/anno', tone: 'danger' },
        { label: 'Da quando', value: 'dal 17.07.2023', tone: 'accent' },
      ],
      advice: 'I nuovi frontalieri oltre 20 km pagano molto più tasse del vecchio regime. Se non hai ancora firmato, valuta la residenza entro 20 km per risparmiare €2.000-4.000/anno.',
      ctaPrimary: { label: 'Calcola il tuo netto 2026', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronta entro vs oltre 20 km', href: '/calcola-stipendio/nuovi-frontalieri-oltre-20-km/' },
      table: {
        caption: 'Netto annuo oltre 20 km · vecchio vs nuovo regime (A0N, Milano)',
        headers: ['Voce', 'Vecchio regime 2025', 'Nuovo regime 2026', 'Δ EUR/anno'],
        rows: [
          { cells: ['RAL CHF 60.000', '~EUR 46.500', '~EUR 44.500', '-2.000'] },
          { cells: ['RAL CHF 80.000', '~EUR 58.500', '~EUR 55.000', '-3.500'], emphasized: true },
          { cells: ['RAL CHF 100.000', '~EUR 70.500', '~EUR 66.000', '-4.500'] },
        ],
        footnote: 'Stime indicative. Oltre 20 km la tassazione concorrente è particolarmente gravosa: l\'IRPEF italiana piena si somma all\'imposta alla fonte CH.',
      },
      faqs: [
        { q: 'Il vecchio regime si applica oltre 20 km?', a: 'Solo per i frontalieri assunti ante 17.07.2023 che già lavoravano oltre i 20 km — caso raro. La grande maggioranza dei frontalieri "storici" risiede entro 20 km.' },
        { q: 'Posso optare per la residenza fiscale CH?', a: 'Sì, se ti trasferisci in Svizzera con permesso B. Devi però rispettare i requisiti di soggiorno (>183 gg/anno in CH).' },
        { q: 'Conviene comunque accettare un\'offerta oltre 20 km?', a: 'Dipende dallo stipendio e dai costi di trasporto/vita. Sopra CHF 90k il vantaggio CH compensa anche oltre 20 km. Usa il simulatore per il tuo caso esatto.' },
      ],
    },
    en: {
      eyebrow: 'Regime comparison · Over 20 km',
      tagline: 'Old regime vs New Agreement 2026: for residents over 20 km, the delta is significant.',
      tiles: [
        { label: 'Old regime', value: 'Rarely applicable', tone: 'neutral' },
        { label: 'New regime', value: '100% CH + Italian IRPEF', tone: 'danger' },
        { label: 'Net delta', value: '-€2,000 - 4,000/year', tone: 'danger' },
        { label: 'Effective since', value: '17 Jul 2023', tone: 'accent' },
      ],
      advice: 'New cross-border workers over 20 km pay significantly more tax than under the old regime. If you have not signed yet, consider residing within 20 km to save €2,000-4,000/year.',
      ctaPrimary: { label: 'Calculate your 2026 net', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'Compare within vs over 20 km', href: '/en/calculate-salary/new-cross-border-workers-over-20km/' },
      table: {
        caption: 'Annual net over 20 km · old vs new regime (A0N, Milan)',
        headers: ['Line', 'Old regime 2025', 'New regime 2026', 'Δ EUR/year'],
        rows: [
          { cells: ['Gross CHF 60,000', '~EUR 46,500', '~EUR 44,500', '-2,000'] },
          { cells: ['Gross CHF 80,000', '~EUR 58,500', '~EUR 55,000', '-3,500'], emphasized: true },
          { cells: ['Gross CHF 100,000', '~EUR 70,500', '~EUR 66,000', '-4,500'] },
        ],
        footnote: 'Indicative estimates. Beyond 20 km, concurrent taxation is particularly heavy: full Italian IRPEF stacks on top of Swiss source tax.',
      },
      faqs: [
        { q: 'Does the old regime apply over 20 km?', a: 'Only for grandfathered workers (hired before 17 Jul 2023) who already lived over 20 km — rare. Most historical cross-border workers reside within 20 km.' },
        { q: 'Can I opt for Swiss tax residence?', a: 'Yes, if you move to Switzerland with a B permit. You must meet residency requirements (>183 days/year in CH).' },
        { q: 'Is an over-20 km offer still worth it?', a: 'Depends on salary and travel/living costs. Above CHF 90k the Swiss advantage compensates even over 20 km. Use the simulator for your exact case.' },
      ],
    },
    de: {
      eyebrow: 'Regime-Vergleich · Über 20 km',
      tagline: 'Altes Regime vs. Neues Abkommen 2026: über 20 km ist die Differenz erheblich.',
      tiles: [
        { label: 'Altes Regime', value: 'Selten anwendbar', tone: 'neutral' },
        { label: 'Neues Regime', value: '100% CH + IT-IRPEF', tone: 'danger' },
        { label: 'Netto-Differenz', value: '-€2.000 - 4.000/Jahr', tone: 'danger' },
        { label: 'Gilt seit', value: '17.07.2023', tone: 'accent' },
      ],
      advice: 'Neue Grenzgänger über 20 km zahlen deutlich mehr Steuern als im alten Regime. Falls noch nicht unterschrieben: Wohnsitz bis 20 km erwägen, um €2.000-4.000/Jahr zu sparen.',
      ctaPrimary: { label: 'Netto 2026 berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'Bis vs. über 20 km vergleichen', href: '/de/gehalt-berechnen/neue-grenzgaenger-ueber-20-km/' },
      table: {
        caption: 'Jahresnetto über 20 km · altes vs. neues Regime (A0N, Mailand)',
        headers: ['Position', 'Altes Regime 2025', 'Neues Regime 2026', 'Δ EUR/Jahr'],
        rows: [
          { cells: ['Brutto CHF 60.000', '~EUR 46.500', '~EUR 44.500', '-2.000'] },
          { cells: ['Brutto CHF 80.000', '~EUR 58.500', '~EUR 55.000', '-3.500'], emphasized: true },
          { cells: ['Brutto CHF 100.000', '~EUR 70.500', '~EUR 66.000', '-4.500'] },
        ],
        footnote: 'Richtwerte. Über 20 km ist die konkurrierende Besteuerung besonders hoch: volle italienische IRPEF zusätzlich zur CH-Quellensteuer.',
      },
      faqs: [
        { q: 'Gilt das alte Regime über 20 km?', a: 'Nur für alte Grenzgänger (vor 17.07.2023 angestellt), die schon über 20 km wohnten — selten. Die meisten historischen Grenzgänger wohnen bis 20 km.' },
        { q: 'Kann ich Schweizer Steuerwohnsitz wählen?', a: 'Ja, mit Umzug in die Schweiz und B-Bewilligung. Wohnsitzanforderungen beachten (>183 Tage/Jahr in CH).' },
        { q: 'Lohnt sich ein Angebot über 20 km trotzdem?', a: 'Abhängig von Gehalt und Pendelkosten. Ab CHF 90k kompensiert der CH-Vorteil auch über 20 km. Simulator für den konkreten Fall verwenden.' },
      ],
    },
    fr: {
      eyebrow: 'Comparaison régimes · Plus 20 km',
      tagline: 'Ancien régime vs Nouvel Accord 2026 : au-delà de 20 km, l\'écart est significatif.',
      tiles: [
        { label: 'Ancien régime', value: 'Rarement applicable', tone: 'neutral' },
        { label: 'Nouveau régime', value: '100% CH + IRPEF IT', tone: 'danger' },
        { label: 'Delta net', value: '-€2 000 - 4 000/an', tone: 'danger' },
        { label: 'En vigueur depuis', value: '17.07.2023', tone: 'accent' },
      ],
      advice: 'Les nouveaux frontaliers au-delà de 20 km paient bien plus d\'impôts qu\'avec l\'ancien régime. Si pas encore signé, envisagez une résidence à moins de 20 km pour économiser €2 000-4 000/an.',
      ctaPrimary: { label: 'Calculer votre net 2026', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer moins/plus 20 km', href: '/fr/calculer-salaire/nouveaux-frontaliers-plus-20-km/' },
      table: {
        caption: 'Net annuel plus 20 km · ancien vs nouveau régime (A0N, Milan)',
        headers: ['Poste', 'Ancien régime 2025', 'Nouveau régime 2026', 'Δ EUR/an'],
        rows: [
          { cells: ['Brut CHF 60 000', '~EUR 46 500', '~EUR 44 500', '-2 000'] },
          { cells: ['Brut CHF 80 000', '~EUR 58 500', '~EUR 55 000', '-3 500'], emphasized: true },
          { cells: ['Brut CHF 100 000', '~EUR 70 500', '~EUR 66 000', '-4 500'] },
        ],
        footnote: 'Estimations indicatives. Au-delà de 20 km, l\'imposition concurrente est particulièrement lourde : IRPEF italien plein cumulé avec l\'impôt source CH.',
      },
      faqs: [
        { q: 'L\'ancien régime s\'applique-t-il au-delà de 20 km ?', a: 'Uniquement pour les anciens frontaliers (embauchés avant le 17.07.2023) qui résidaient déjà au-delà de 20 km — cas rare. La majorité des frontaliers historiques résident à moins de 20 km.' },
        { q: 'Puis-je opter pour la résidence fiscale CH ?', a: 'Oui, si vous déménagez en Suisse avec un permis B. Respectez les exigences de résidence (>183 jours/an en CH).' },
        { q: 'Une offre au-delà de 20 km en vaut-elle quand même la peine ?', a: 'Selon le salaire et les coûts trajet/vie. Au-dessus de CHF 90k l\'avantage CH compense même au-delà de 20 km. Utilisez le simulateur pour votre cas précis.' },
      ],
    },
  },

  'confronto-permesso-g-vs-b-entro-20km': {
    it: {
      eyebrow: 'Permesso G vs B · Entro 20 km',
      tagline: 'Frontaliere (G) vs residente CH (B) a parità di stipendio: chi prende più netto?',
      tiles: [
        { label: 'Permit G', value: 'Tassazione concorrente', tone: 'warning' },
        { label: 'Permit B', value: 'Solo tasse CH', tone: 'success' },
        { label: 'Cassa malati', value: 'LAMal obbligatoria (B)', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 80k+', tone: 'neutral' },
      ],
      advice: 'Sopra CHF 80.000 di RAL il permesso B paga ~CHF 3.000/anno in meno di tasse. Sotto, il G mantiene il vantaggio per flessibilità + SSN italiano opzionale.',
      ctaPrimary: { label: 'Calcola scenari G vs B', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronto LAMal vs SSN', href: '/compara-servizi/confronta-casse-malati/' },
      table: {
        caption: 'Netto annuo Permit G vs B · entro 20 km (single, A0N, Lugano)',
        headers: ['Voce', 'Permit G (Italia)', 'Permit B (CH)', 'Δ a favore B'],
        rows: [
          { cells: ['RAL CHF 60.000', '~CHF 44.000', '~CHF 45.500', '+CHF 1.500'] },
          { cells: ['RAL CHF 80.000', '~CHF 55.000', '~CHF 58.000', '+CHF 3.000'], emphasized: true },
          { cells: ['RAL CHF 100.000', '~CHF 67.000', '~CHF 71.000', '+CHF 4.000'] },
        ],
        footnote: 'Stime al netto di trasporto frontaliere (G) e LAMal CHF 4.800/anno (B). LAMal obbligatoria con B; G può scegliere SSN o LAMal.',
      },
      faqs: [
        { q: 'Quanto serve di stipendio per giustificare il permesso B?', a: 'Tipicamente da CHF 80.000+: sopra questa soglia il risparmio fiscale CH copre i costi extra (LAMal, affitto Lugano).' },
        { q: 'Posso passare da G a B mantenendo lo stesso lavoro?', a: 'Sì, ma serve trasferimento di residenza in Svizzera (>183 gg/anno) + permesso B (richiesta al Comune CH).' },
        { q: 'LAMal o SSN: cosa scelgo con permesso G?', a: 'Hai diritto d\'opzione: scegli una volta sola, scelta irrevocabile. LAMal copre meglio in CH, SSN è gratuito ma copre solo IT. Vedi il comparatore.' },
      ],
    },
    en: {
      eyebrow: 'Permit G vs B · Within 20 km',
      tagline: 'Cross-border worker (G) vs Swiss resident (B) at the same gross: who takes home more?',
      tiles: [
        { label: 'Permit G', value: 'Concurrent taxation', tone: 'warning' },
        { label: 'Permit B', value: 'Swiss tax only', tone: 'success' },
        { label: 'Health insurance', value: 'LAMal mandatory (B)', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 80k+', tone: 'neutral' },
      ],
      advice: 'Above CHF 80,000 gross, Permit B pays ~CHF 3,000/year less tax. Below that, Permit G keeps its edge thanks to flexibility + optional Italian SSN.',
      ctaPrimary: { label: 'Calculate G vs B scenarios', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'LAMal vs SSN comparison', href: '/en/comparators/compare-health-insurance/' },
      table: {
        caption: 'Annual net Permit G vs B · within 20 km (single, A0N, Lugano)',
        headers: ['Line', 'Permit G (Italy)', 'Permit B (CH)', 'Δ favour B'],
        rows: [
          { cells: ['Gross CHF 60,000', '~CHF 44,000', '~CHF 45,500', '+CHF 1,500'] },
          { cells: ['Gross CHF 80,000', '~CHF 55,000', '~CHF 58,000', '+CHF 3,000'], emphasized: true },
          { cells: ['Gross CHF 100,000', '~CHF 67,000', '~CHF 71,000', '+CHF 4,000'] },
        ],
        footnote: 'Net of cross-border travel (G) and LAMal CHF 4,800/year (B). LAMal mandatory with B; G can choose SSN or LAMal.',
      },
      faqs: [
        { q: 'How much salary justifies Permit B?', a: 'Typically from CHF 80,000+: above this threshold the Swiss tax saving covers extra costs (LAMal, Lugano rent).' },
        { q: 'Can I switch from G to B keeping the same job?', a: 'Yes, but you must move your residence to Switzerland (>183 days/year) and apply for a B permit at your Swiss municipality.' },
        { q: 'LAMal or SSN with Permit G?', a: 'You have an opt-in right: one-shot choice, irrevocable. LAMal covers better in CH, SSN is free but covers only Italy. See the comparator.' },
      ],
    },
    de: {
      eyebrow: 'G vs B · Bis 20 km',
      tagline: 'Grenzgänger (G) vs Schweizer Resident (B) bei gleichem Brutto: wer behält mehr netto?',
      tiles: [
        { label: 'G-Bewilligung', value: 'Konkurrierende Besteuerung', tone: 'warning' },
        { label: 'B-Bewilligung', value: 'Nur Schweizer Steuern', tone: 'success' },
        { label: 'Krankenkasse', value: 'LAMal Pflicht (B)', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 80k+', tone: 'neutral' },
      ],
      advice: 'Ab CHF 80.000 brutto zahlt die B-Bewilligung ~CHF 3.000/Jahr weniger Steuern. Darunter behält die G-Bewilligung den Vorteil dank Flexibilität + optionalem italienischem SSN.',
      ctaPrimary: { label: 'G vs B Szenarien berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'LAMal vs SSN Vergleich', href: '/de/comparators/krankenkassen-vergleichen/' },
      table: {
        caption: 'Jahresnetto G vs B · bis 20 km (ledig, A0N, Lugano)',
        headers: ['Position', 'G (Italien)', 'B (CH)', 'Δ zugunsten B'],
        rows: [
          { cells: ['Brutto CHF 60.000', '~CHF 44.000', '~CHF 45.500', '+CHF 1.500'] },
          { cells: ['Brutto CHF 80.000', '~CHF 55.000', '~CHF 58.000', '+CHF 3.000'], emphasized: true },
          { cells: ['Brutto CHF 100.000', '~CHF 67.000', '~CHF 71.000', '+CHF 4.000'] },
        ],
        footnote: 'Netto nach Grenzgänger-Pendel (G) und LAMal CHF 4.800/Jahr (B). LAMal Pflicht mit B; G hat Wahl SSN/LAMal.',
      },
      faqs: [
        { q: 'Welches Gehalt rechtfertigt eine B-Bewilligung?', a: 'Typischerweise ab CHF 80.000+: oberhalb dieser Schwelle decken die CH-Steuerersparnisse die Mehrkosten (LAMal, Miete Lugano).' },
        { q: 'Kann ich von G zu B wechseln und denselben Job behalten?', a: 'Ja, aber Wohnsitz muss in die Schweiz (>183 Tage/Jahr) und B-Bewilligung beim Schweizer Wohnort beantragen.' },
        { q: 'LAMal oder SSN mit G-Bewilligung?', a: 'Optionsrecht: einmalige, unwiderrufliche Wahl. LAMal deckt besser in CH, SSN ist gratis aber nur IT. Siehe Vergleich.' },
      ],
    },
    fr: {
      eyebrow: 'Permis G vs B · Moins 20 km',
      tagline: 'Frontalier (G) vs résident CH (B) à brut égal : qui touche le plus de net ?',
      tiles: [
        { label: 'Permis G', value: 'Imposition concurrente', tone: 'warning' },
        { label: 'Permis B', value: 'Impôts CH seulement', tone: 'success' },
        { label: 'Caisse maladie', value: 'LAMal obligatoire (B)', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 80k+', tone: 'neutral' },
      ],
      advice: 'Au-dessus de CHF 80 000 brut, le permis B paie ~CHF 3 000/an d\'impôts en moins. En-dessous, le G garde l\'avantage grâce à flexibilité + SSN italien optionnel.',
      ctaPrimary: { label: 'Calculer scénarios G vs B', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer LAMal vs SSN', href: '/fr/comparators/comparer-caisses-maladie/' },
      table: {
        caption: 'Net annuel Permis G vs B · moins 20 km (célibataire, A0N, Lugano)',
        headers: ['Poste', 'Permis G (Italie)', 'Permis B (CH)', 'Δ en faveur B'],
        rows: [
          { cells: ['Brut CHF 60 000', '~CHF 44 000', '~CHF 45 500', '+CHF 1 500'] },
          { cells: ['Brut CHF 80 000', '~CHF 55 000', '~CHF 58 000', '+CHF 3 000'], emphasized: true },
          { cells: ['Brut CHF 100 000', '~CHF 67 000', '~CHF 71 000', '+CHF 4 000'] },
        ],
        footnote: 'Net après transport frontalier (G) et LAMal CHF 4 800/an (B). LAMal obligatoire avec B ; G peut choisir SSN ou LAMal.',
      },
      faqs: [
        { q: 'Quel salaire justifie le permis B ?', a: 'Typiquement dès CHF 80 000+ : au-dessus de ce seuil l\'économie fiscale CH couvre les coûts supplémentaires (LAMal, loyer Lugano).' },
        { q: 'Puis-je passer de G à B en gardant le même travail ?', a: 'Oui, mais transfert de résidence en Suisse (>183 jours/an) et demande de permis B à la commune CH.' },
        { q: 'LAMal ou SSN avec permis G ?', a: 'Droit d\'option : choix unique, irrévocable. LAMal couvre mieux en CH, SSN est gratuit mais ne couvre que l\'Italie. Voir le comparateur.' },
      ],
    },
  },

  'confronto-permesso-g-vs-b-oltre-20km': {
    it: {
      eyebrow: 'Permesso G vs B · Oltre 20 km',
      tagline: 'Frontaliere oltre 20 km (G) vs residente CH (B): per i nuovi frontalieri il permesso B è quasi sempre più conveniente.',
      tiles: [
        { label: 'Permit G oltre 20 km', value: '100% fonte + IRPEF IT', tone: 'danger' },
        { label: 'Permit B', value: 'Solo tasse CH', tone: 'success' },
        { label: 'Delta a favore B', value: '+CHF 4.000-6.000/anno', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 60k', tone: 'warning' },
      ],
      advice: 'Per i nuovi frontalieri oltre 20 km, il permesso B è quasi sempre più conveniente. Verifica fattibilità: residenza CH, lingua, contratto stabile, requisiti permesso B.',
      ctaPrimary: { label: 'Calcola G oltre 20 km vs B', href: '/calcola-stipendio/' },
      ctaSecondary: { label: 'Confronto LAMal vs SSN', href: '/compara-servizi/confronta-casse-malati/' },
      table: {
        caption: 'Netto annuo G (oltre 20 km) vs B · 2026 (single, A0N)',
        headers: ['Voce', 'Permit G (>20 km)', 'Permit B (CH)', 'Δ a favore B'],
        rows: [
          { cells: ['RAL CHF 60.000', '~CHF 42.000', '~CHF 45.500', '+CHF 3.500'] },
          { cells: ['RAL CHF 80.000', '~CHF 52.500', '~CHF 58.000', '+CHF 5.500'], emphasized: true },
          { cells: ['RAL CHF 100.000', '~CHF 64.000', '~CHF 71.000', '+CHF 7.000'] },
        ],
        footnote: 'Stime al netto di trasporto (G) e LAMal (B). Il permesso B vince quasi sempre per i nuovi frontalieri oltre 20 km.',
      },
      faqs: [
        { q: 'Perché il delta è così alto oltre 20 km?', a: 'Perché il nuovo regime tassa il 100% in CH + l\'IRPEF italiana piena (no split 80/20). Il permesso B paga solo la fonte CH, evitando la doppia imposta.' },
        { q: 'Quali requisiti per il permesso B?', a: 'Contratto di lavoro CH valido, alloggio a tuo nome, dimostrazione mezzi sufficienti, dichiarazione iscrizione anagrafica al Comune CH. Variabile per cantone.' },
        { q: 'Conviene anche se ho famiglia in Italia?', a: 'Più complesso: trasferimento famiglia comporta cambio scuole, lavoro coniuge, sanità. Spesso conviene se entrambi possono trasferirsi.' },
      ],
    },
    en: {
      eyebrow: 'Permit G vs B · Over 20 km',
      tagline: 'Cross-border worker over 20 km (G) vs Swiss resident (B): for new workers, Permit B is almost always better.',
      tiles: [
        { label: 'Permit G over 20 km', value: '100% source + IT IRPEF', tone: 'danger' },
        { label: 'Permit B', value: 'Swiss tax only', tone: 'success' },
        { label: 'Δ favour B', value: '+CHF 4,000-6,000/year', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 60k', tone: 'warning' },
      ],
      advice: 'For new cross-border workers over 20 km, Permit B is almost always more convenient. Check feasibility: Swiss residence, language, stable contract, B-permit requirements.',
      ctaPrimary: { label: 'Calculate G over 20 km vs B', href: '/en/calculate-salary/' },
      ctaSecondary: { label: 'LAMal vs SSN comparison', href: '/en/comparators/compare-health-insurance/' },
      table: {
        caption: 'Annual net G (over 20 km) vs B · 2026 (single, A0N)',
        headers: ['Line', 'Permit G (>20 km)', 'Permit B (CH)', 'Δ favour B'],
        rows: [
          { cells: ['Gross CHF 60,000', '~CHF 42,000', '~CHF 45,500', '+CHF 3,500'] },
          { cells: ['Gross CHF 80,000', '~CHF 52,500', '~CHF 58,000', '+CHF 5,500'], emphasized: true },
          { cells: ['Gross CHF 100,000', '~CHF 64,000', '~CHF 71,000', '+CHF 7,000'] },
        ],
        footnote: 'Net of travel (G) and LAMal (B). Permit B almost always wins for new cross-border workers over 20 km.',
      },
      faqs: [
        { q: 'Why is the delta so large over 20 km?', a: 'Because the new regime taxes 100% in CH plus full Italian IRPEF (no 80/20 split). Permit B pays only Swiss source tax, avoiding double taxation.' },
        { q: 'What are B-permit requirements?', a: 'Valid Swiss employment contract, accommodation in your name, sufficient means, registration at the Swiss municipality. Varies by canton.' },
        { q: 'Worth it if my family lives in Italy?', a: 'More complex: family move means new schools, partner job, healthcare. Often worth it if both can relocate.' },
      ],
    },
    de: {
      eyebrow: 'G vs B · Über 20 km',
      tagline: 'Grenzgänger über 20 km (G) vs Schweizer Resident (B): für neue Grenzgänger ist B fast immer günstiger.',
      tiles: [
        { label: 'G über 20 km', value: '100% Quelle + IT-IRPEF', tone: 'danger' },
        { label: 'B-Bewilligung', value: 'Nur Schweizer Steuern', tone: 'success' },
        { label: 'Δ zugunsten B', value: '+CHF 4.000-6.000/Jahr', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 60k', tone: 'warning' },
      ],
      advice: 'Für neue Grenzgänger über 20 km ist die B-Bewilligung fast immer günstiger. Machbarkeit prüfen: CH-Wohnsitz, Sprache, stabiler Vertrag, B-Bewilligungsanforderungen.',
      ctaPrimary: { label: 'G über 20 km vs B berechnen', href: '/de/gehalt-berechnen/' },
      ctaSecondary: { label: 'LAMal vs SSN Vergleich', href: '/de/comparators/krankenkassen-vergleichen/' },
      table: {
        caption: 'Jahresnetto G (über 20 km) vs B · 2026 (ledig, A0N)',
        headers: ['Position', 'G (>20 km)', 'B (CH)', 'Δ zugunsten B'],
        rows: [
          { cells: ['Brutto CHF 60.000', '~CHF 42.000', '~CHF 45.500', '+CHF 3.500'] },
          { cells: ['Brutto CHF 80.000', '~CHF 52.500', '~CHF 58.000', '+CHF 5.500'], emphasized: true },
          { cells: ['Brutto CHF 100.000', '~CHF 64.000', '~CHF 71.000', '+CHF 7.000'] },
        ],
        footnote: 'Netto nach Pendel (G) und LAMal (B). B-Bewilligung gewinnt fast immer für neue Grenzgänger über 20 km.',
      },
      faqs: [
        { q: 'Warum ist die Differenz über 20 km so gross?', a: 'Weil das neue Regime 100 % in CH + volle italienische IRPEF besteuert (kein 80/20-Split). B zahlt nur CH-Quellensteuer und vermeidet die Doppelbesteuerung.' },
        { q: 'Was braucht eine B-Bewilligung?', a: 'Gültiger CH-Arbeitsvertrag, Wohnung auf eigenen Namen, ausreichende Mittel, Anmeldung bei der CH-Wohngemeinde. Kanton-abhängig.' },
        { q: 'Lohnt es sich auch mit Familie in Italien?', a: 'Komplexer: Familienumzug bedeutet Schulwechsel, Partnerarbeit, Gesundheit. Oft lohnend, wenn beide umziehen können.' },
      ],
    },
    fr: {
      eyebrow: 'Permis G vs B · Plus 20 km',
      tagline: 'Frontalier plus 20 km (G) vs résident CH (B) : pour les nouveaux frontaliers, le permis B est presque toujours plus avantageux.',
      tiles: [
        { label: 'Permis G plus 20 km', value: '100% source + IRPEF IT', tone: 'danger' },
        { label: 'Permis B', value: 'Impôts CH seulement', tone: 'success' },
        { label: 'Δ en faveur B', value: '+CHF 4 000-6 000/an', tone: 'accent' },
        { label: 'Break-even', value: 'CHF 60k', tone: 'warning' },
      ],
      advice: 'Pour les nouveaux frontaliers au-delà de 20 km, le permis B est presque toujours plus avantageux. Vérifiez faisabilité : résidence CH, langue, contrat stable, exigences permis B.',
      ctaPrimary: { label: 'Calculer G plus 20 km vs B', href: '/fr/calculer-salaire/' },
      ctaSecondary: { label: 'Comparer LAMal vs SSN', href: '/fr/comparators/comparer-caisses-maladie/' },
      table: {
        caption: 'Net annuel G (plus 20 km) vs B · 2026 (célibataire, A0N)',
        headers: ['Poste', 'Permis G (>20 km)', 'Permis B (CH)', 'Δ en faveur B'],
        rows: [
          { cells: ['Brut CHF 60 000', '~CHF 42 000', '~CHF 45 500', '+CHF 3 500'] },
          { cells: ['Brut CHF 80 000', '~CHF 52 500', '~CHF 58 000', '+CHF 5 500'], emphasized: true },
          { cells: ['Brut CHF 100 000', '~CHF 64 000', '~CHF 71 000', '+CHF 7 000'] },
        ],
        footnote: 'Net après transport (G) et LAMal (B). Le permis B gagne presque toujours pour les nouveaux frontaliers au-delà de 20 km.',
      },
      faqs: [
        { q: 'Pourquoi un delta si grand au-delà de 20 km ?', a: 'Parce que le nouveau régime impose 100 % en CH + IRPEF italien plein (pas de split 80/20). Le permis B ne paie que l\'impôt source CH, évitant la double imposition.' },
        { q: 'Quelles sont les exigences du permis B ?', a: 'Contrat de travail CH valide, logement à votre nom, ressources suffisantes, déclaration d\'inscription à la commune CH. Variable selon canton.' },
        { q: 'Vaut-il le coup avec famille en Italie ?', a: 'Plus complexe : déménagement familial = nouvelles écoles, emploi conjoint, santé. Souvent intéressant si les deux peuvent déménager.' },
      ],
    },
  },
};

function parseNetComparisonPath(canonicalPath: string): { key: NetComparisonKey; locale: SalaryLocale } | null {
  const stripped = canonicalPath.replace(/\/+$/, '');
  // IT canonical paths
  const itSlugs: Array<{ slug: string; key: NetComparisonKey }> = [
    { slug: '/calcola-stipendio/confronto-netto-2025-2026-entro-20km', key: 'confronto-netto-2025-2026-entro-20km' },
    { slug: '/calcola-stipendio/confronto-netto-2025-2026-oltre-20km', key: 'confronto-netto-2025-2026-oltre-20km' },
    { slug: '/calcola-stipendio/confronto-permesso-g-vs-b-entro-20km', key: 'confronto-permesso-g-vs-b-entro-20km' },
    { slug: '/calcola-stipendio/confronto-permesso-g-vs-b-oltre-20km', key: 'confronto-permesso-g-vs-b-oltre-20km' },
  ];
  for (const { slug, key } of itSlugs) {
    if (stripped === slug) return { key, locale: 'it' };
  }
  // Per live sitemap-pages.xml the net-comparison URLs are IT-only.
  // EN/DE/FR were never emitted as static landings — no mapping needed.
  return null;
}

function resolveScenarioData(canonicalPath: string): { data: SalaryLandingData; locale: SalaryLocale } {
  const stripped = canonicalPath.replace(/\/+$/, '');
  // 1. Hub lookup
  const hubHit = HUB_PATH_TO_KEY[stripped];
  if (hubHit) {
    // HUB_SCENARIOS[key][locale] may be undefined for hubs that only ship
    // an IT dataset; fall back to IT when the requested locale is missing.
    const localeData = HUB_SCENARIOS[hubHit.key][hubHit.locale] ?? HUB_SCENARIOS[hubHit.key].it;
    if (localeData) return { data: localeData, locale: hubHit.locale };
  }
  // 2. Salary-tier pattern
  const tierHit = parseSalaryTierPath(canonicalPath);
  if (tierHit) {
    return {
      data: buildSalaryTierData({ ral: tierHit.ral, variant: tierHit.variant }, tierHit.locale),
      locale: tierHit.locale,
    };
  }
  // 3. Net-comparison pattern (regime 2025 vs 2026, permit G vs B)
  const compHit = parseNetComparisonPath(canonicalPath);
  if (compHit) {
    return {
      data: NET_COMPARISON_SCENARIOS[compHit.key][compHit.locale],
      locale: compHit.locale,
    };
  }
  // 4. Generic default — anything else under /calcola-stipendio/*
  const locale = detectLocale(canonicalPath);
  const pack = LOCALE_PACKS[locale];
  return {
    data: {
      eyebrow: pack.breadcrumbHub,
      tagline: pack.ctaPrimary,
      tiles: [
        { label: locale === 'it' ? 'Aliquote' : locale === 'en' ? 'Rates' : locale === 'de' ? 'Sätze' : 'Taux', value: 'Ticino 2026', tone: 'accent' },
        { label: locale === 'it' ? 'Franchigia IT' : locale === 'en' ? 'IT allowance' : locale === 'de' ? 'IT-Freibetrag' : 'Franchise IT', value: 'EUR 10.000', tone: 'success' },
        { label: locale === 'it' ? 'Cambio' : locale === 'en' ? 'FX rate' : locale === 'de' ? 'Kurs' : 'Taux', value: 'CHF/EUR BNS', tone: 'neutral' },
        { label: locale === 'it' ? 'Tabelle fonte' : locale === 'en' ? 'Source tables' : locale === 'de' ? 'Quelltabellen' : 'Barèmes source', value: 'A · B · C · H', tone: 'neutral' },
      ],
      ctaPrimary: { label: pack.ctaPrimary, href: pack.simulatorHref },
      ctaSecondary: { label: pack.ctaSecondary, href: pack.whatIfHref },
    },
    locale,
  };
}

// ── Renderers ────────────────────────────────────────────────────────────────

function renderAdvice(label: string, text: string): string {
  return `<aside data-salary-advice style="${STAT_TILE_WARNING};margin:0 0 18px"><p style="${SMALL_HEADING_STYLE};margin:0 0 6px">${esc(label)}</p><p style="margin:0;color:var(--color-heading);line-height:1.55;font-size:15px">${esc(text)}</p></aside>`;
}

function renderCtaBlock(
  primary: SalaryLandingData['ctaPrimary'],
  secondary: SalaryLandingData['ctaSecondary'],
): string {
  const secondaryHtml = secondary
    ? `<a href="${esc(secondary.href)}" style="${LINK_ACCENT_STYLE};font-weight:600;font-size:15px;align-self:center">${esc(secondary.label)} →</a>`
    : '';
  return `<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:0 0 28px"><a href="${esc(primary.href)}" style="${CTA_PRIMARY_STYLE}">${esc(primary.label)} →</a>${secondaryHtml}</div>`;
}

function renderTable(table: SalaryTable): string {
  const headCells = table.headers
    .map((h) => `<th scope="col" style="${TABLE_HEAD_STYLE}">${esc(h)}</th>`)
    .join('');
  const bodyRows = table.rows
    .map((row) => {
      const rowStyle = row.emphasized
        ? 'background:var(--color-accent-subtle)'
        : '';
      const cells = row.cells
        .map(
          (c, i) =>
            `<td style="${TABLE_CELL_STYLE}${i === row.cells.length - 1 ? ';font-weight:700;color:var(--color-heading)' : ''}">${esc(c)}</td>`,
        )
        .join('');
      return `<tr style="${rowStyle}">${cells}</tr>`;
    })
    .join('');
  const footnote = table.footnote
    ? `<p style="margin:8px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${esc(table.footnote)}</p>`
    : '';
  return `<section style="margin:0 0 28px" aria-labelledby="salary-table-caption"><p id="salary-table-caption" style="${SMALL_HEADING_STYLE};margin:0 0 10px">${esc(table.caption)}</p><div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="${TABLE_STYLE}"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>${footnote}</section>`;
}

function renderFaqs(label: string, faqs: ReadonlyArray<SalaryFaqItem>): string {
  if (!faqs.length) return '';
  const items = faqs
    .map(
      (f) =>
        `<details style="border-top:1px solid var(--color-edge);padding:14px 0"><summary style="cursor:pointer;font-weight:600;color:var(--color-heading);font-size:15px;line-height:1.4;list-style:none">${esc(f.q)}</summary><p style="margin:10px 0 0;color:var(--color-body);line-height:1.6;font-size:15px">${esc(f.a)}</p></details>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><p style="${SMALL_HEADING_STYLE};margin:0 0 4px">${esc(label)}</p>${items}</section>`;
}

export interface BuildSalaryLandingArgs {
  readonly canonicalPath: string;
  readonly h1Text: string;
  readonly seoDesc: string;
  readonly editorialHtml: string;
  readonly navHtml: string;
}

export interface RenderShellArgs {
  readonly h1Text: string;
  /** Optional rich HTML to render in the data-area slot (replaces auto-rendered table from data.table). */
  readonly dataAreaHtmlOverride?: string;
  /** Long prose block (5+ paragraph editorial, related-grid, AdSense) rendered at the bottom. */
  readonly editorialHtml?: string;
  /** Footer nav block (raw HTML). */
  readonly navHtml?: string;
}

/**
 * Render the mobile-first SEO-landing shell from explicit data + locale.
 * Used directly by salaryHubPlugin (which computes per-scenario data from
 * `SalaryHubScenario` + `SimulationResult`). `buildSalaryLandingBody` is
 * a thin wrapper that first resolves data from a canonical path.
 */
export function renderSalaryLandingShell(
  data: SalaryLandingData,
  locale: SalaryLocale,
  args: RenderShellArgs,
): string {
  const pack = LOCALE_PACKS[locale];

  const breadcrumb = renderBreadcrumb([
    { label: pack.breadcrumbHome, href: '/' },
    { label: pack.breadcrumbHub, href: pack.hubHref },
    { label: args.h1Text },
  ]);

  const eyebrow = `<p style="${HERO_EYEBROW_STYLE}">${esc(data.eyebrow)}</p>`;
  const h1 = `<h1 style="${H1_STYLE}">${esc(args.h1Text)}</h1>`;
  const lede = `<p style="${LEDE_STYLE}">${esc(data.tagline)}</p>`;

  const tilesHtml = renderStatGrid(data.tiles);
  const adviceHtml = data.advice ? renderAdvice(pack.adviceLabel, data.advice) : '';
  const ctaHtml = renderCtaBlock(data.ctaPrimary, data.ctaSecondary);
  const dataAreaHtml = args.dataAreaHtmlOverride ?? (data.table ? renderTable(data.table) : '');
  const faqsHtml = data.faqs ? renderFaqs(pack.faqsLabel, data.faqs) : '';

  const prose = args.editorialHtml
    ? `<section style="margin:32px 0 0;border-top:1px solid var(--color-edge);padding-top:24px">${args.editorialHtml}</section>`
    : '';

  const navHtml = args.navHtml
    ? `<nav aria-label="${esc(pack.navLabel)}" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--color-edge);font-size:13px;color:var(--color-subtle);line-height:1.9">${args.navHtml}</nav>`
    : '';

  return `<div style="max-width:64rem;margin:0 auto;padding:16px 16px 32px;font-family:inherit">${breadcrumb}<header style="margin:0 0 20px">${eyebrow}${h1}${lede}</header>${tilesHtml}${adviceHtml}${ctaHtml}${dataAreaHtml}${faqsHtml}${prose}${navHtml}</div>`;
}

export function buildSalaryLandingBody(args: BuildSalaryLandingArgs): string {
  const { data, locale } = resolveScenarioData(args.canonicalPath);
  return renderSalaryLandingShell(data, locale, {
    h1Text: args.h1Text,
    editorialHtml: args.editorialHtml,
    navHtml: args.navHtml,
  });
}

// ── Test helpers (exported for unit tests) ──────────────────────────────────

export const _internal = {
  parseSalaryTierPath,
  parseNetComparisonPath,
  resolveScenarioData,
  HUB_PATH_TO_KEY,
};
