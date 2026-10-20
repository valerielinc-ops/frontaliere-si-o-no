/**
 * Compact, locale-aware navigation for profession-led job pages.
 *
 * The links are supplied by each page builder so the shared renderer can be
 * reused by profession, nursing, sector, and regional landings without
 * coupling it to any one route table. The analytics labels use the site's
 * existing global anchor click tracking.
 */

export type ProfessionJourneyLocale = 'it' | 'en' | 'de' | 'fr';
export type ProfessionJourneyStep = 'offers' | 'requirements' | 'net' | 'companies' | 'alert';

export const PROFESSION_JOURNEY_ANCHORS = {
  offers: 'profession-offers',
  requirements: 'profession-requirements',
  companies: 'profession-companies',
} as const;

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
    netWithReportedSalary: 'Lordo annuo dagli annunci → simula il netto',
    netNeedsInput: 'Inserisci il lordo annuo per simulare il netto',
    netReportedAriaLabel: 'Simula il netto usando la mediana del lordo annuo riportato in almeno cinque annunci verificati. Non è un netto né uno stipendio personale garantito.',
    netNeedsInputAriaLabel: 'Inserisci il tuo lordo annuo per simulare il netto.',
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
    netWithReportedSalary: 'Reported annual gross → estimate net',
    netNeedsInput: 'Enter annual gross pay to estimate net',
    netReportedAriaLabel: 'Estimate net pay using the median annual gross reported in at least five verified job ads. This is not net pay or a guaranteed personal salary.',
    netNeedsInputAriaLabel: 'Enter your annual gross pay to estimate net pay.',
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
    netReportedAriaLabel: 'Nettolohn anhand des Medians des in mindestens fünf geprüften Stellenanzeigen gemeldeten Jahresbruttos schätzen. Dies ist kein Nettolohn und kein garantiertes persönliches Gehalt.',
    netNeedsInputAriaLabel: 'Geben Sie Ihr Jahresbrutto ein, um den Nettolohn zu schätzen.',
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
    netReportedAriaLabel: 'Estimer le net à partir de la médiane du brut annuel déclaré dans au moins cinq annonces vérifiées. Ce montant n’est ni un salaire net ni un salaire personnel garanti.',
    netNeedsInputAriaLabel: 'Saisissez votre brut annuel pour estimer le net.',
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

/** Render a five-step journey with caller-owned, already verified targets. */
export function renderProfessionJourney(options: ProfessionJourneyOptions): string {
  const copy = COPY[options.locale];
  const roleKey = analyticsKey(options.professionKey);
  const heading = options.roleLabel ? copy.headingForRole(options.roleLabel) : copy.heading;
  const steps = STEP_ORDER.map((step, index) => `
      <li>
        <a href="${escapeHtml(options.hrefs[step])}"${step === 'net' ? ` aria-label="${escapeHtml(options.netSalaryPrefilled ? copy.netReportedAriaLabel : copy.netNeedsInputAriaLabel)}"` : ''} data-analytics-label="profession_journey:${roleKey}:${step}" class="flex min-h-11 items-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-2 text-sm font-semibold text-heading hover:border-accent">
          <span aria-hidden="true" class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs text-accent">${index + 1}</span>
          <span>${escapeHtml(step === 'net'
            ? (options.netSalaryPrefilled ? copy.netWithReportedSalary : copy.netNeedsInput)
            : copy.steps[step])}</span>
        </a>
      </li>`).join('');

  return `<nav class="my-4 rounded-lg border border-edge bg-surface p-3" data-profession-journey="${escapeHtml(roleKey)}" aria-label="${escapeHtml(copy.ariaLabel)}">
    <p class="mb-2 text-sm font-bold text-heading">${escapeHtml(heading)}</p>
    <ol class="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-5">${steps}
    </ol>
  </nav>`;
}
