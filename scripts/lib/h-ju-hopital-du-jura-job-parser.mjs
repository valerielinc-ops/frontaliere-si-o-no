#!/usr/bin/env node
/**
 * Hôpital du Jura (H-JU) — Jura cantonal hospital group.
 *
 * Public corporate career page:
 *   https://www.h-ju.ch/fr/Carrieres/Emploi/Emploi.html
 *
 * The corporate page embeds the Johdi Suite widget; the actual job data
 * lives behind the standard Johdi Suite public API. See
 * `scripts/lib/johdisuite-common.mjs` for ATS details.
 *
 * `companyHashKey` was lifted from the widget mount node:
 *   <div id="ats-offers" data-locale="fr"
 *        data-company-hash-key="eyJpdiI6..." data-flow="web">
 * It is an encrypted Laravel payload that identifies the tenant — STABLE
 * across deploys; we just need to refresh it if H-JU ever rotates keys.
 */
import { createJohdiSuiteParser } from './johdisuite-common.mjs';

export const H_JU_KEY = 'h-ju-hopital-du-jura';
export const H_JU_COMPANY_NAME = 'Hôpital du Jura (H-JU)';
export const H_JU_COMPANY_DOMAIN = 'h-ju.ch';

// Lifted from https://www.h-ju.ch/fr/Carrieres/Emploi/Emploi.html — the
// `data-company-hash-key` on the `#ats-offers` widget container.
const COMPANY_HASH_KEY = 'eyJpdiI6InplWFBubkJ0Qzh5c3dnTlgzUkR3Y1E9PSIsInZhbHVlIjoiaUhITmZucEoxVk0xYXd1Y2FPT0Y1Zz09IiwibWFjIjoiNmFjOGNlZDY1MDcwMWY0YjVlYTM2MTIxODViYmFmNGNiMGNjZjQwN2E3NmU2MDZkY2NiMjA3NjcyMjRkNWYwYSIsInRhZyI6IiJ9';

const parser = createJohdiSuiteParser({
  companyKey: H_JU_KEY,
  companyName: H_JU_COMPANY_NAME,
  companyDomain: H_JU_COMPANY_DOMAIN,
  companyHashKey: COMPANY_HASH_KEY,
  publicationFlow: 'web',
  locale: 'fr',
  publicCareerUrl: 'https://www.h-ju.ch/fr/Carrieres/Emploi/Emploi.html',
  defaultCanton: 'JU',
  defaultCity: 'Delémont',
  defaultPostalCode: '2800',
  sourceLabel: 'H-JU Hôpital du Jura Dedicated Parser (Johdi Suite)',
  fallbackBrandBlurb:
    "L'Hôpital du Jura (H-JU) est le réseau hospitalier public du canton du Jura, avec les sites de Delémont, Porrentruy et Saignelégier. Plus de 1'200 collaboratrices et collaborateurs assurent la prise en charge médicale et soignante de la population jurassienne.",
});

export const fetchAllHJuJobs = parser.fetchAllJobs;
export const isHJuJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
