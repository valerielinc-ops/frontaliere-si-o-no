#!/usr/bin/env node
/**
 * Luzerner Kantonsspital (LUKS) job parser — Prospective.ch (medium 1003280).
 *
 * Public career site: https://www.luks.ch/karriere
 *   → published listing platform: https://jobs.luks.ch/offene-stellen/
 *   → backed by Prospective.ch v1 listing endpoint:
 *     https://ohws.prospective.ch/public/v1/medium/1003280/jobs?lang=de
 *
 * History: the previous implementation here probed the LUKS Gatsby-based
 * www.luks.ch page-data.json and the sitemap (`/stellen-und-karriere/...`).
 * Both paths returned 0 jobs because LUKS pulled the public JobAbo while the
 * platform migrated. The new public listing is `jobs.luks.ch` (a Prospective
 * directlink) and the same data is exposed via medium ID 1003280 — which
 * confirms 221+ live adverts (LUKS + KSNW = Spital Nidwalden, same tenant).
 *
 * Migrated 2026-05-19 to the shared Prospective.ch factory. All fetch +
 * parse logic now lives in `prospective-ch-job-parser-common.mjs`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLuksJobs()  — Fetch and parse all jobs
 *   - isLuksJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - LUKS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LUKS_KEY = 'luks';
export const LUKS_COMPANY_NAME = 'Luzerner Kantonsspital (LUKS)';
export const LUKS_COMPANY_DOMAIN = 'luks.ch';

const parser = createProspectiveChParser({
  companyKey: LUKS_KEY,
  companyName: LUKS_COMPANY_NAME,
  companyDomain: LUKS_COMPANY_DOMAIN,
  mediumId: '1003280',
  apiLang: 'de',
  defaultCanton: 'LU',
  defaultCity: 'Luzern',
  defaultPostalCode: '6000',
  publicCareerUrl: 'https://www.luks.ch/karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.luks.ch', 'recruitment.luks.ch'],
});

/* ── Public API ────────────────────────────────────────────── */

/**
 * Fetch all Luzerner Kantonsspital (LUKS) jobs from Prospective.ch.
 * Returns ParsedJob[] (source-locale only, needsRetranslation: true).
 */
export const fetchAllLuksJobs = parser.fetchAllJobs;

/**
 * Match jobs belonging to LUKS in the global slice (companyKey or URL).
 */
export const isLuksJob = parser.isCompanyJob;

/**
 * Validate that a URL belongs to LUKS-trusted domains.
 * Accepts: luks.ch (+ subdomains), jobs.luks.ch, recruitment.luks.ch,
 *          ohws.prospective.ch/public/v1/medium/1003280/...
 */
export const isTrustedDomain = parser.isTrustedDomain;
