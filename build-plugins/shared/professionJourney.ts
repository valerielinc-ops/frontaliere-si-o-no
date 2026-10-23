/**
 * Compact, locale-aware navigation for profession-led job pages.
 *
 * The links are supplied by each page builder so the shared renderer can be
 * reused by profession, nursing, sector, and regional landings without
 * coupling it to any one route table. The analytics labels use the site's
 * existing global anchor click tracking.
 */
import { CALC_HREF } from './calcHref';

export type ProfessionJourneyLocale = 'it' | 'en' | 'de' | 'fr';
export type ProfessionJourneyStep = 'offers' | 'requirements' | 'net' | 'companies' | 'alert';

export const PROFESSION_JOURNEY_ANCHORS = {
  offers: 'profession-offers',
  requirements: 'profession-requirements',
  companies: 'profession-companies',
} as const;

const REQUIREMENTS_COPY: Record<ProfessionJourneyLocale, {
  heading: string;
  body: (role: string) => string;
}> = {
  it: {
    heading: 'Cosa verificare nei requisiti',
    body: (role) => `Per il ruolo di ${role}, qualifiche, esperienza e lingue richieste dipendono dal singolo annuncio e dal datore di lavoro. Controlla le condizioni nella fonte originale prima di candidarti.`,
  },
  en: {
    heading: 'What to check in each listing',
    body: (role) => `For ${role} roles, required qualifications, experience and languages depend on the vacancy and employer. Check the original posting before applying.`,
  },
  de: {
    heading: 'Anforderungen in den Anzeigen prüfen',
    body: (role) => `Welche Qualifikationen, Erfahrung und Sprachen für ${role} verlangt werden, hängt von der einzelnen Stelle und dem Arbeitgeber ab. Prüfen Sie die Angaben vor der Bewerbung in der Originalanzeige.`,
  },
  fr: {
    heading: 'Vérifier les exigences de chaque offre',
    body: (role) => `Pour le métier de ${role}, les qualifications, l’expérience et les langues demandées dépendent de l’offre et de l’employeur. Vérifiez l’annonce originale avant de postuler.`,
  },
};

export interface ProfessionJourneyOptions {
  locale: ProfessionJourneyLocale;
  /** Stable, URL-independent role identifier used by the click tracker. */
  professionKey: string;
  /** Short localized label that makes role-specific or sector-wide scope explicit. */
  roleLabel?: string;
  hrefs: Record<ProfessionJourneyStep, string>;
  /** True only when `hrefs.net` contains an observed, provenance-checked gross salary. */
  netSalaryPrefilled: boolean;
}

const COPY: Record<ProfessionJourneyLocale, {
  ariaLabel: string;
  heading: string;
  headingForRole: (roleLabel: string) => string;
  steps: Record<ProfessionJourneyStep, string>;
  netWithReportedSalary: string;
  netNeedsInput: string;
  netReportedAriaLabel: string;
  netNeedsInputAriaLabel: string;
  netScopeNote: string;
}> = {
  it: {
    ariaLabel: 'Percorso per orientarti tra le offerte',
    heading: 'Dal ruolo alla candidatura',
    headingForRole: (roleLabel) => `Percorso: ${roleLabel}`,
    steps: {
      offers: 'Offerte',
      requirements: 'Requisiti',
      net: 'Simula il netto',
      companies: 'Aziende',
      alert: 'Avvisi sulle nuove offerte',
    },
    netWithReportedSalary: 'Lordo annuo annunci → simula il netto',
    netNeedsInput: 'Inserisci il lordo annuo per simulare il netto',
    netReportedAriaLabel: 'Simula il netto usando la mediana del lordo annuo riportato in almeno cinque annunci verificati. Il calcolatore applica il regime Italia-Svizzera, con imposta alla fonte ticinese e IRPEF italiana: non calcola le imposte del cantone di questa pagina e non garantisce uno stipendio personale.',
    netNeedsInputAriaLabel: 'Inserisci il lordo annuo per simulare il regime Italia-Svizzera con imposta alla fonte ticinese e IRPEF italiana; il risultato non calcola le imposte del cantone di questa pagina.',
    netScopeNote: 'Il simulatore applica il regime Italia-Svizzera con imposta alla fonte ticinese e IRPEF italiana; non è un calcolo fiscale del cantone di questa pagina.',
  },
  en: {
    ariaLabel: 'Explore this role and its job openings',
    heading: 'From role to application',
    headingForRole: (roleLabel) => `Your path for ${roleLabel}`,
    steps: {
      offers: 'Openings',
      requirements: 'Requirements',
      net: 'Estimate net pay',
      companies: 'Employers',
      alert: 'Get new-job alerts',
    },
    netWithReportedSalary: 'Reported annual gross → estimate net pay',
    netNeedsInput: 'Enter annual gross pay to estimate net',
    netReportedAriaLabel: 'Estimate using the median annual gross reported in at least five verified job ads. The calculator applies the Italy-Switzerland regime, with Ticino withholding tax and Italian IRPEF; it does not calculate tax for the canton on this page or guarantee a personal salary.',
    netNeedsInputAriaLabel: 'Enter annual gross to simulate the Italy-Switzerland regime with Ticino withholding tax and Italian IRPEF; the result does not calculate tax for the canton on this page.',
    netScopeNote: 'The simulator applies the Italy-Switzerland regime with Ticino withholding tax and Italian IRPEF; it does not calculate tax for the canton on this page.',
  },
  de: {
    ariaLabel: 'Stellenangebote für diesen Beruf erkunden',
    heading: 'Vom Beruf zur Bewerbung',
    headingForRole: (roleLabel) => `Ihr Weg für ${roleLabel}`,
    steps: {
      offers: 'Stellen',
      requirements: 'Anforderungen',
      net: 'Nettolohn berechnen',
      companies: 'Unternehmen',
      alert: 'Neue Stellen melden lassen',
    },
    netWithReportedSalary: 'Gemeldetes Jahresbrutto → Nettolohn schätzen',
    netNeedsInput: 'Jahresbrutto eingeben und Nettolohn schätzen',
    netReportedAriaLabel: 'Schätzung mit dem Median des in mindestens fünf geprüften Stellenanzeigen gemeldeten Jahresbruttos. Der Rechner bildet das Regime Italien-Schweiz mit Tessiner Quellensteuer und italienischer IRPEF ab; er berechnet nicht die Steuern des Kantons auf dieser Seite und garantiert keinen persönlichen Lohn.',
    netNeedsInputAriaLabel: 'Geben Sie Ihr Jahresbrutto für eine Simulation des Regimes Italien-Schweiz mit Tessiner Quellensteuer und italienischer IRPEF ein; die Steuern des Kantons auf dieser Seite werden nicht berechnet.',
    netScopeNote: 'Der Rechner bildet das Regime Italien-Schweiz mit Tessiner Quellensteuer und italienischer IRPEF ab; er berechnet nicht die Steuern des Kantons auf dieser Seite.',
  },
  fr: {
    ariaLabel: 'Explorer ce métier et ses offres',
    heading: 'Du métier à la candidature',
    headingForRole: (roleLabel) => `Votre parcours : ${roleLabel}`,
    steps: {
      offers: 'Offres',
      requirements: 'Exigences',
      net: 'Estimer le salaire net',
      companies: 'Employeurs',
      alert: 'Recevoir les nouvelles offres',
    },
    netWithReportedSalary: 'Brut annuel déclaré → estimer le net',
    netNeedsInput: 'Saisir le brut annuel pour estimer le net',
    netReportedAriaLabel: 'Estimation à partir de la médiane du brut annuel déclaré dans au moins cinq annonces vérifiées. Le calculateur applique le régime Italie-Suisse, avec impôt à la source tessinois et IRPEF italienne ; il ne calcule pas l’impôt du canton de cette page et ne garantit aucun salaire personnel.',
    netNeedsInputAriaLabel: 'Saisissez le brut annuel pour simuler le régime Italie-Suisse avec impôt à la source tessinois et IRPEF italienne ; le résultat ne calcule pas l’impôt du canton de cette page.',
    netScopeNote: 'Le calculateur applique le régime Italie-Suisse avec impôt à la source tessinois et IRPEF italienne ; il ne calcule pas l’impôt du canton de cette page.',
  },
};

const STEP_ORDER: readonly ProfessionJourneyStep[] = [
  'offers',
  'requirements',
  'net',
  'companies',
  'alert',
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function analyticsKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'profession';
}

function canonicalJobBoardPath(jobBoardPath: string): string {
  const pathOnly = jobBoardPath.split(/[?#]/, 1)[0].trim();
  if (!pathOnly.startsWith('/')) throw new Error('A canonical job-board path is required.');
  return pathOnly.endsWith('/') ? pathOnly : `${pathOnly}/`;
}

function professionQuery(keyword: string): string {
  const cleanKeyword = keyword.trim();
  if (!cleanKeyword) throw new Error('A non-empty profession keyword is required.');
  return new URLSearchParams({ q: cleanKeyword }).toString();
}

/** Build a canonical job-board URL with the site's existing `q` filter. */
export function buildProfessionJourneySearchHref(jobBoardPath: string, keyword: string): string {
  return `${canonicalJobBoardPath(jobBoardPath)}?${professionQuery(keyword)}`;
}

/** Build the existing job-board search URL that opens the alert form. */
export function buildProfessionJourneyAlertHref(jobBoardPath: string, keyword: string): string {
  const canonicalPath = canonicalJobBoardPath(jobBoardPath);
  const params = new URLSearchParams(professionQuery(keyword));
  params.set('alert', '1');
  return `${canonicalPath}?${params.toString()}#job-alert-form`;
}

/** Prefill the calculator only with a caller-verified annual gross CHF figure. */
export function buildProfessionJourneyNetHref(
  calculatorPath: string,
  annualGrossChf: number | null | undefined,
): string {
  const pathOnly = calculatorPath.split(/[?#]/, 1)[0].trim();
  if (!pathOnly.startsWith('/')) throw new Error('A canonical calculator path is required.');
  const canonicalPath = pathOnly.endsWith('/') ? pathOnly : `${pathOnly}/`;
  if (typeof annualGrossChf !== 'number' || !Number.isFinite(annualGrossChf) || annualGrossChf <= 0) {
    return canonicalPath;
  }
  const query = new URLSearchParams({ reddito: String(Math.round(annualGrossChf)) });
  return `${canonicalPath}?${query.toString()}`;
}

/** Build the localized calculator URL, prefilled only with a verified annual gross CHF figure. */
export function buildProfessionJourneyNetHrefForLocale(
  locale: ProfessionJourneyLocale,
  annualGrossChf: number | null | undefined,
): string {
  return buildProfessionJourneyNetHref(CALC_HREF[locale], annualGrossChf);
}

/** Render safe, role-level guidance without inferring canton-specific requirements. */
export function renderProfessionRequirementsGuidance(
  locale: ProfessionJourneyLocale,
  role: string,
): string {
  const copy = REQUIREMENTS_COPY[locale];
  return `<section id="${PROFESSION_JOURNEY_ANCHORS.requirements}" class="mt-5 rounded-md border border-edge bg-surface p-4">
    <h2 class="text-lg font-bold text-heading">${escapeHtml(copy.heading)}</h2>
    <p class="mt-2 text-sm text-body">${escapeHtml(copy.body(role))}</p>
  </section>`;
}

/** Explain an empty employer sample without inventing names or relabeling offers as companies. */
export function renderProfessionCompaniesEmptyState(locale: ProfessionJourneyLocale, searchHref: string): string {
  const copy = {
    it: {
      heading: 'Aziende indicate negli annunci',
      body: 'Il campione di questa pagina non contiene nomi di aziende sufficienti per un elenco affidabile. Apri le offerte per controllare il datore indicato in ciascun annuncio.',
      link: 'Vedi le offerte filtrate',
    },
    en: {
      heading: 'Employers named in the listings',
      body: 'This page sample does not contain enough employer names for a reliable list. Open the openings to check the employer shown in each listing.',
      link: 'View matching openings',
    },
    de: {
      heading: 'In den Anzeigen genannte Arbeitgeber',
      body: 'Die Stichprobe dieser Seite enthält nicht genügend Unternehmensnamen für eine verlässliche Liste. Öffnen Sie die Stellen und prüfen Sie den Arbeitgeber in jeder Anzeige.',
      link: 'Passende Stellen ansehen',
    },
    fr: {
      heading: 'Employeurs nommés dans les offres',
      body: 'L’échantillon de cette page ne contient pas assez de noms d’employeurs pour établir une liste fiable. Ouvrez les offres pour vérifier l’employeur indiqué dans chaque annonce.',
      link: 'Voir les offres correspondantes',
    },
  }[locale];
  return `<section id="${PROFESSION_JOURNEY_ANCHORS.companies}" class="mt-5 rounded-md border border-edge bg-surface p-4">
    <h2 class="text-lg font-bold text-heading">${escapeHtml(copy.heading)}</h2>
    <p class="mt-2 text-sm text-body">${escapeHtml(copy.body)}</p>
    <p class="mt-2"><a class="font-semibold text-accent underline" href="${escapeHtml(searchHref)}">${escapeHtml(copy.link)} →</a></p>
  </section>`;
}

/** Render a five-step journey with caller-owned, already verified targets. */
export function renderProfessionJourney(options: ProfessionJourneyOptions): string {
  const copy = COPY[options.locale];
  const roleKey = analyticsKey(options.professionKey);
  const heading = options.roleLabel ? copy.headingForRole(options.roleLabel) : copy.heading;
  const ariaLabel = options.roleLabel ? `${copy.ariaLabel}: ${options.roleLabel}` : copy.ariaLabel;
  const steps = STEP_ORDER.map((step, index) => `
      <li>
        <a href="${escapeHtml(options.hrefs[step])}"${step === 'net' ? ` aria-label="${escapeHtml(options.netSalaryPrefilled ? copy.netReportedAriaLabel : copy.netNeedsInputAriaLabel)}"` : ''} data-analytics-label="profession_journey:${roleKey}:${step}" class="flex min-h-11 items-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-2 text-sm font-semibold text-heading hover:border-accent">
          <span aria-hidden="true" class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs text-accent">${index + 1}</span>
          <span class="min-w-0">${escapeHtml(step === 'net'
            ? (options.netSalaryPrefilled ? copy.netWithReportedSalary : copy.netNeedsInput)
            : copy.steps[step])}${step === 'net' ? `<span class="mt-1 block text-xs font-normal text-subtle">${escapeHtml(copy.netScopeNote)}</span>` : ''}</span>
        </a>
      </li>`).join('');

  return `<nav class="my-4 rounded-lg border border-edge bg-surface p-3" data-profession-journey="${escapeHtml(roleKey)}" aria-label="${escapeHtml(ariaLabel)}">
    <p class="mb-2 text-sm font-bold text-heading">${escapeHtml(heading)}</p>
    <ol class="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-5">${steps}
    </ol>
  </nav>`;
}
