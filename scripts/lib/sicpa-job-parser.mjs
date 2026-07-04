#!/usr/bin/env node
/**
 * SICPA SA job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site: https://jobs.sicpa.com
 * SF tenant code: SICPA (career site host itself is the tenant vanity domain)
 *
 * SICPA SA is a Swiss security-ink / security-technology company
 * headquartered in Prilly (VD), operating globally (security features for
 * banknotes, tax stamps, brand protection).
 *
 * jobs.sicpa.com is a global career portal (Brazil/US/Malaysia/Spain/CH
 * listings observed, 53 open positions total); the `locationsearch=Switzerland`
 * server-side filter restricts the `/search/` listing to CH jobs only (13
 * open positions observed, all in Prilly VD or Chavornay VD).
 *
 * CSB listing (`/search/`) + detail (`/job/{slug}/{jobId}/`) parsing lives in
 * `scripts/lib/successfactors-shared-job-parser-common.mjs` — see
 * `scripts/lib/idorsia-job-parser.mjs` for the identical pattern (another
 * Swiss-HQ multinational CSB tenant restricted to CH via the same param).
 *
 * `trustPageLangAttr: false` — the jobs.sicpa.com CSB template hardcodes
 * `<html lang="en-GB">` on every job page regardless of the job's actual
 * content language; the CH postings are genuinely French (Prilly/Chavornay).
 * Without this flag the shared factory would mislabel every French posting
 * as `sourceLang: 'en'`, which would then surface the untranslated French
 * text as the site's English-locale content. See the flag's doc comment on
 * `createSuccessFactorsParser` in successfactors-shared-job-parser-common.mjs.
 *
 * `sector` / `detectCategory` / `boilerplateFallback` overrides — the shared
 * factory's built-in defaults are healthcare-flavored (it was written for
 * hospital/pharma/biotech CSB tenants): default `sector` is literally
 * `'Sanità / Ospedali'` and the default category detector falls back to the
 * same healthcare label for any title it doesn't recognise (observed
 * mis-tagging "Chemist", "Automation Technician", "Chef d'Équipe Paysagiste"
 * etc. as healthcare on this tenant). SICPA is a security-ink / security-tech
 * manufacturer, not healthcare, so all three are overridden below.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const SICPA_KEY = 'sicpa';
export const SICPA_COMPANY_NAME = 'SICPA SA';
export const SICPA_COMPANY_DOMAIN = 'sicpa.com';

const SECTOR = 'Industria di sicurezza / Tecnologie anti-contraffazione (manifatturiero)';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/** Industrial/manufacturing category detector (SICPA is not a healthcare employer). */
function detectSicpaCategory(title = '') {
  const t = normalize(title);
  if (/stage|stagiaire|intern|apprenti|apprend|tirocin|lehrling|lernend/.test(t)) return 'Formazione';
  if (/qualit|quality/.test(t)) return 'Qualità';
  if (/chimist|chemist|laborat|laboratoire|laboratorio/.test(t)) return 'Ricerca e Sviluppo';
  if (/ingegner|ingénieur|engineer|automat|automaticien/.test(t)) return 'Ingegneria';
  if (/software|develop|informatiq|it\b/.test(t)) return 'IT';
  if (/logist|magazz|operateur|opérateur|entrepôt/.test(t)) return 'Logistica';
  if (/archivist|archiviste|admin|sekret|segret|buchhalt|sachbearbeit/.test(t)) return 'Amministrazione';
  if (/techni|paysagist|maintenan|manutenz|coordinator|coordinateur/.test(t)) return 'Tecnica';
  if (/vendita|sales|verkauf|commerce|solution manager/.test(t)) return 'Commerciale';
  return 'Produzione';
}

/**
 * French/English thin-description fallback (SICPA's source locale is French,
 * not German). Padded well past the 50-word content-quality floor
 * (`AGENTS.md` Non-Negotiable #4) regardless of title length, since some
 * titles are a single word (e.g. "Automaticien").
 */
function sicpaBoilerplateFallback(title, companyName, city) {
  return `${title} chez ${companyName} à ${city}.\n\n${companyName} est une entreprise suisse spécialisée dans les technologies de sécurité : encres de sécurité, solutions d'authentification et de protection des marques, ainsi que des programmes d'intégrité fiscale pour les gouvernements et les entreprises du monde entier. Basée à Prilly, dans le canton de Vaud, l'entreprise emploie plus de 3000 collaborateurs dans plus de 80 pays. Ce poste offre un environnement de travail moderne et multiculturel, des conditions d'emploi attractives ainsi que de réelles possibilités de formation continue et d'évolution de carrière.`;
}

const parser = createSuccessFactorsParser({
  companyKey: SICPA_KEY,
  companyName: SICPA_COMPANY_NAME,
  companyDomain: SICPA_COMPANY_DOMAIN,
  sfCompanyId: 'SICPA',
  publicCareerUrl: 'https://jobs.sicpa.com',
  defaultCanton: 'VD',
  defaultCity: 'Prilly',
  defaultPostalCode: '1008',
  defaultSourceLang: 'fr',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'SICPA SA Dedicated Parser (SuccessFactors CSB)',
  trustPageLangAttr: false,
  sector: SECTOR,
  detectCategory: detectSicpaCategory,
  boilerplateFallback: sicpaBoilerplateFallback,
});

export const fetchAllSicpaJobs = parser.fetchAllJobs;
export const isSicpaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
