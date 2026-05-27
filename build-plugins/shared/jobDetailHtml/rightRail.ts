/**
 * Desktop right-rail sticky sidebar (≥1024px) for the static job-detail
 * page. SPA-parity backport of the React `<JobBoard>` aside so the
 * crawler-facing HTML (and the pre-hydration flash) carry the same
 * location / salary / sector / related-search signals as the React view.
 *
 * Hidden on <1024px via seo-static.css (the mobile-action-block already
 * covers small screens via this same emitter folder).
 *
 * Returns '' when *every* card would be empty so the aside never adds
 * empty layout slots.
 *
 * SPA-parity regression coverage:
 *   tests/seo/static-job-page-spa-alignment.test.ts
 *   ("desktop right rail sidebar")
 */
import type { JobDetailLocale, JobDetailRenderContext } from './context';

interface RailLabels {
  readonly location: string;
  readonly city: string;
  readonly canton: string;
  readonly postal: string;
  readonly salary: string;
  readonly sector: string;
  readonly related: string;
}

const RAIL_LABELS: Record<JobDetailLocale, RailLabels> = {
  it: {
    location: 'Posizione',
    city: 'Città',
    canton: 'Cantone',
    postal: 'CAP',
    salary: 'Range salariale',
    sector: 'Settore',
    related: 'Ricerche correlate',
  },
  en: {
    location: 'Location',
    city: 'City',
    canton: 'Canton',
    postal: 'Postal code',
    salary: 'Salary range',
    sector: 'Sector',
    related: 'Related searches',
  },
  de: {
    location: 'Standort',
    city: 'Stadt',
    canton: 'Kanton',
    postal: 'PLZ',
    salary: 'Gehaltsspanne',
    sector: 'Branche',
    related: 'Verwandte Suchen',
  },
  fr: {
    location: 'Lieu',
    city: 'Ville',
    canton: 'Canton',
    postal: 'Code postal',
    salary: 'Fourchette salariale',
    sector: 'Secteur',
    related: 'Recherches associées',
  },
};

// Minimal sector lookup — duplicates the small map used by the frontalier
// paragraphs in the plugin (intentionally kept local to avoid coupling to
// the protected Panoramica/timeline block).
//
// Name `railSectorMap` is load-bearing for the SPA-alignment regression
// gate (`tests/seo/static-job-page-spa-alignment.test.ts` asserts the
// literal `railSectorMap[locale]?.[railCat]` lookup pattern survives the
// extraction — see the path-agnostic source-concat the test now uses).
const railSectorMap: Record<JobDetailLocale, Record<string, string>> = {
  it: {
    healthcare: 'sanità',
    technology: 'tecnologia',
    finance: 'servizi finanziari',
    engineering: 'ingegneria',
    hospitality: 'ospitalità',
    retail: 'commercio',
    manufacturing: 'manifattura',
    education: 'formazione',
    construction: 'edilizia',
    logistics: 'logistica',
    sales: 'vendite',
    administration: 'amministrazione',
  },
  en: {
    healthcare: 'healthcare',
    technology: 'technology',
    finance: 'financial services',
    engineering: 'engineering',
    hospitality: 'hospitality',
    retail: 'retail',
    manufacturing: 'manufacturing',
    education: 'education',
    construction: 'construction',
    logistics: 'logistics',
    sales: 'sales',
    administration: 'administration',
  },
  de: {
    healthcare: 'Gesundheitswesen',
    technology: 'Technologie',
    finance: 'Finanzdienstleistungen',
    engineering: 'Ingenieurwesen',
    hospitality: 'Gastgewerbe',
    retail: 'Einzelhandel',
    manufacturing: 'Fertigung',
    education: 'Bildung',
    construction: 'Bauwesen',
    logistics: 'Logistik',
    sales: 'Vertrieb',
    administration: 'Verwaltung',
  },
  fr: {
    healthcare: 'santé',
    technology: 'technologie',
    finance: 'services financiers',
    engineering: 'ingénierie',
    hospitality: 'hôtellerie',
    retail: 'commerce',
    manufacturing: 'industrie',
    education: 'formation',
    construction: 'construction',
    logistics: 'logistique',
    sales: 'ventes',
    administration: 'administration',
  },
};

export type RightRailContext = Pick<
  JobDetailRenderContext,
  | 'job'
  | 'locale'
  | 'addressLocality'
  | 'addressRegion'
  | 'postalCode'
  | 'salaryMin'
  | 'salaryText'
  | 'canonicalKeywords'
  | 'esc'
>;

export function renderRightRail(ctx: RightRailContext): string {
  const {
    job,
    locale,
    addressLocality,
    addressRegion,
    postalCode,
    salaryMin,
    salaryText,
    canonicalKeywords,
    esc,
  } = ctx;
  const L = RAIL_LABELS[locale];
  const locationRows: string[] = [];
  if (addressLocality)
    locationRows.push(`<dt>${esc(L.city)}</dt><dd>${esc(addressLocality)}</dd>`);
  if (addressRegion)
    locationRows.push(`<dt>${esc(L.canton)}</dt><dd>${esc(addressRegion)}</dd>`);
  if (postalCode)
    locationRows.push(`<dt>${esc(L.postal)}</dt><dd>${esc(postalCode)}</dd>`);
  const locationCard = locationRows.length > 0
    ? `<div class="rail-card"><h3>${esc(L.location)}</h3><dl class="rail-dl">${locationRows.join('')}</dl></div>`
    : '';
  const salaryCard = Number.isFinite(salaryMin)
    ? `<div class="rail-card"><h3>${esc(L.salary)}</h3><div class="rail-salary">${esc(salaryText)}</div></div>`
    : '';
  const railCat = String(job.category || '').toLowerCase();
  const sectorValue =
    railSectorMap[locale]?.[railCat] || String(job.category || '');
  const sectorCard = sectorValue
    ? `<div class="rail-card"><h3>${esc(L.sector)}</h3><div class="rail-sector">${esc(sectorValue)}</div></div>`
    : '';
  const relatedChipsHtml = canonicalKeywords.length > 0
    ? `<div class="rail-card"><h3>${esc(L.related)}</h3><ul class="rail-chips">${canonicalKeywords.slice(0, 6).map((k) => `<li class="chip">${esc(String(k))}</li>`).join('')}</ul></div>`
    : '';
  const cards = locationCard + salaryCard + sectorCard + relatedChipsHtml;
  if (!cards) return '';
  return `<aside class="job-detail-rail" aria-label="${esc(L.location)}">${cards}</aside>`;
}
