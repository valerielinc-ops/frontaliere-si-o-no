#!/usr/bin/env node
/**
 * LIVIT AG job parser — Prospective.ch medium 1006570.
 *
 * Background:
 * LIVIT AG is a Swiss real-estate management company (part of the Swiss
 * Life group — "Livit" is Swiss Life's property-management arm), direct
 * employer, no staffing-agency risk. ~17 open positions across property
 * management (Immobilienbewirtschaftung), HR services, accounting
 * (Comptable Immobilier / Gérance), spread across ZH, GE, VD, BE, SO,
 * BS, SG.
 *
 * Discovery-tag caution: the queue tagged this as "jobs.ch (feed)" via
 * the `jobs.livit.ch` hostname, which is WRONG — `jobs.livit.ch` is
 * Livit's own careercenter domain, not a jobs.ch feed. Fetching it live
 * shows it embeds the Prospective.ch careercenter widget
 * (`ohws.prospective.ch/careercenter/1006570/...`), confirmed by the
 * public listing API returning real jobs at medium 1006570. Individual
 * listings' `sza_apply_link` points to a Swiss Life Workday tenant
 * (swisslife.wd3.myworkdayjobs.com) for the actual application form —
 * that's just the downstream apply flow, not the listing source; the
 * public JSON API this crawler reads is Prospective, same as other
 * tenants in this codebase.
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1006570/jobs?lang=de
 * Public career site: https://jobs.livit.ch
 *
 * Default canton ZH (Livit HQ: Altstetterstrasse 124, 8048 Zürich); postal/
 * street used only as a city-gated HQ fallback per the shared factory.
 *
 * Uses shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const LIVIT_KEY = 'livit';
export const LIVIT_COMPANY_NAME = 'Livit AG';
export const LIVIT_COMPANY_DOMAIN = 'livit.ch';

const parser = createProspectiveChParser({
  companyKey: LIVIT_KEY,
  companyName: LIVIT_COMPANY_NAME,
  companyDomain: LIVIT_COMPANY_DOMAIN,
  mediumId: '1006570',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8048',
  defaultStreetAddress: 'Altstetterstrasse 124',
  publicCareerUrl: 'https://jobs.livit.ch',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.livit.ch'],
});

export const fetchAllLivitJobs = parser.fetchAllJobs;
export const isLivitJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
