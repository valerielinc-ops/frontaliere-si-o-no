#!/usr/bin/env node
/**
 * Étab. Hospitaliers du Nord Vaudois (eHnv) job parser — Johdi Suite ATS.
 *
 * Public career site: https://www.ehnv.ch/emplois
 *
 * The corporate page embeds the Johdi Suite widget; the actual job data
 * lives behind the standard Johdi Suite public API. See
 * `scripts/lib/johdisuite-common.mjs` for ATS details.
 *
 * `companyHashKey` was lifted from the widget mount node on the public
 * /emplois page (Jul 2026):
 *   <div id="ats-offers" data-locale="fr"
 *        data-company-hash-key="eyJpdiI6..." data-flow="web">
 * It is an encrypted Laravel payload that identifies the tenant — STABLE
 * across deploys; refresh only if eHnv ever rotates the key.
 *
 * NOTE: the jobup.ch mask `ehnv` (formerly used here) has returned 0 jobs
 * for 5+ consecutive days while this page lists ~15 real openings — that
 * feed is stale/disconnected for this tenant. Confirmed via live browser
 * capture 2026-07-08.
 */
import { createJohdiSuiteParser } from './johdisuite-common.mjs';

export const EHNV_KEY = 'ehnv';
export const EHNV_COMPANY_NAME = 'Étab. Hospitaliers du Nord Vaudois (eHnv)';
export const EHNV_COMPANY_DOMAIN = 'ehnv.ch';

// Lifted from https://www.ehnv.ch/emplois — the `data-company-hash-key`
// on the `#ats-offers` widget container (Jul 2026).
const COMPANY_HASH_KEY = 'eyJpdiI6ImUyU3A5TThUTzhLbGF0SFZSNyt4Wnc9PSIsInZhbHVlIjoid2pDemlDZXFCb2E4d2N0Y0lqU0IrQT09IiwibWFjIjoiYTY3NjQ4MWQxN2YyZTlhN2FmNThiZjY5NGY2OGM1NmRjODgzNmNhZWQ1YWJkMGNkYTlmMDQ5M2ZlMjFjMjliNCIsInRhZyI6IiJ9';

const parser = createJohdiSuiteParser({
  companyKey: EHNV_KEY,
  companyName: EHNV_COMPANY_NAME,
  companyDomain: EHNV_COMPANY_DOMAIN,
  companyHashKey: COMPANY_HASH_KEY,
  publicationFlow: 'web',
  locale: 'fr',
  publicCareerUrl: 'https://www.ehnv.ch/emplois',
  defaultCanton: 'VD',
  defaultCity: 'Yverdon-les-Bains',
  defaultPostalCode: '1400',
  sourceLabel: 'eHnv Dedicated Parser (Johdi Suite)',
  fallbackBrandBlurb:
    "Les eHnv (Établissements hospitaliers du Nord vaudois) sont le premier employeur du Nord vaudois avec plus de 1'600 collaboratrices et collaborateurs, répartis sur les sites d'Yverdon, Chamblon, Orbe et Saint-Loup.",
});

export const fetchAllEhnvJobs = parser.fetchAllJobs;
export const isEhnvJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
