import type { FaqHubEntry, FaqHubCategory, FaqHubLocale } from './types';
import { FAQ_HUB_CATEGORIES, FAQ_HUB_LOCALES } from './types';
import { FAQ_avsLpp } from './category-avs-lpp';
import { FAQ_diritti } from './category-diritti';
import { FAQ_famiglia } from './category-famiglia';
import { FAQ_fisco } from './category-fisco';
import { FAQ_lamal } from './category-lamal';
import { FAQ_lavoro } from './category-lavoro';
import { FAQ_permessi } from './category-permessi';
import { FAQ_stipendi } from './category-stipendi';
import { FAQ_trasporti } from './category-trasporti';
import { FAQ_vitaQuotidiana } from './category-vita-quotidiana';

/**
 * AE-5 FAQ hub aggregate — 10 categories × 10 entries = 100 Q&A.
 *
 * Order: alphabetical by category, stable by entry id within each.
 * This is the source of truth consumed by `faqHubPlugin.ts` (build-time
 * HTML + FAQPage JSON-LD) and by any future SPA components.
 *
 * Pure TS: no `node:*` imports so the router can import helpers if needed.
 */

const CATEGORY_MAP: Record<FaqHubCategory, ReadonlyArray<FaqHubEntry>> = {
  'avs-lpp': FAQ_avsLpp,
  'diritti': FAQ_diritti,
  'famiglia': FAQ_famiglia,
  'fisco': FAQ_fisco,
  'lamal': FAQ_lamal,
  'lavoro': FAQ_lavoro,
  'permessi': FAQ_permessi,
  'stipendi': FAQ_stipendi,
  'trasporti': FAQ_trasporti,
  'vita-quotidiana': FAQ_vitaQuotidiana,
};

function sortById<T extends { id: string }>(entries: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

export const ALL_FAQ_HUB: ReadonlyArray<FaqHubEntry> = FAQ_HUB_CATEGORIES.flatMap(
  (cat) => sortById(CATEGORY_MAP[cat]),
);

export function getFaqHubByCategory(category: FaqHubCategory): ReadonlyArray<FaqHubEntry> {
  return sortById(CATEGORY_MAP[category]);
}

export { FAQ_HUB_CATEGORIES, FAQ_HUB_LOCALES };
export type { FaqHubEntry, FaqHubCategory, FaqHubLocale };

// Re-export route helpers from the router-safe module. See routes.ts for
// the rationale (keeps the 340KB category data out of the SPA bundle).
export {
  FAQ_HUB_LOCALE_PREFIX,
  FAQ_HUB_SLUG,
  buildFaqHubPath,
  FAQ_HUB_ROUTES,
  parseFaqHubPath,
  isFaqHubPath,
} from './routes';

// ── Category labels per locale ────────────────────────────────────

export const FAQ_HUB_CATEGORY_LABELS: Record<
  FaqHubCategory,
  Record<FaqHubLocale, string>
> = {
  fisco: {
    it: 'Fisco e imposta alla fonte',
    en: 'Tax and withholding',
    de: 'Steuern und Quellensteuer',
    fr: 'Fiscalité et impôt à la source',
  },
  lamal: {
    it: 'LAMal e assicurazione sanitaria',
    en: 'LAMal and health insurance',
    de: 'KVG und Krankenversicherung',
    fr: 'LAMal et assurance maladie',
  },
  permessi: {
    it: 'Permessi G, B e residenza',
    en: 'Permits G, B and residency',
    de: 'Bewilligungen G, B und Wohnsitz',
    fr: 'Permis G, B et résidence',
  },
  'avs-lpp': {
    it: 'AVS, AI e 2° pilastro LPP',
    en: 'AVS, AI and 2nd pillar LPP',
    de: 'AHV, IV und 2. Säule BVG',
    fr: 'AVS, AI et 2e pilier LPP',
  },
  stipendi: {
    it: 'Stipendi, tredicesima e CCL',
    en: 'Salary, 13th-month and CLA',
    de: 'Lohn, 13. Monatslohn und GAV',
    fr: 'Salaire, 13e mois et CCT',
  },
  trasporti: {
    it: 'Trasporti, auto e frontiera',
    en: 'Transport, car and border',
    de: 'Verkehr, Auto und Grenze',
    fr: 'Transports, voiture et frontière',
  },
  lavoro: {
    it: 'Cercare lavoro e CV',
    en: 'Job search and CV',
    de: 'Stellensuche und Lebenslauf',
    fr: "Recherche d'emploi et CV",
  },
  'vita-quotidiana': {
    it: 'Vita quotidiana, casa, scuola',
    en: 'Daily life, home and school',
    de: 'Alltag, Wohnen und Schule',
    fr: 'Vie quotidienne, logement et école',
  },
  famiglia: {
    it: 'Famiglia, assegni e maternità',
    en: 'Family, allowances and maternity',
    de: 'Familie, Zulagen und Mutterschaft',
    fr: 'Famille, allocations et maternité',
  },
  diritti: {
    it: 'Diritti, licenziamento e mobbing',
    en: 'Rights, dismissal and mobbing',
    de: 'Rechte, Kündigung und Mobbing',
    fr: 'Droits, licenciement et mobbing',
  },
};
