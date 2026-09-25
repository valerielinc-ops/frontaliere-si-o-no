#!/usr/bin/env node
/**
 * Bühler Group job parser — Prospective.ch (medium 1008005).
 *
 * Bühler is a Swiss industrial technology group (food processing & advanced
 * materials) headquartered in Uzwil (SG). Its public career site
 * (https://jobs.buhlergroup.com/) embeds a Prospective.ch careercenter; the
 * careercenter ID matches the Prospective v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1008005/jobs?lang=de
 *
 * The tenant lists the Swiss (Uzwil HQ) openings. Canton SG, postal 9240
 * (Gupfenstrasse 5, Uzwil).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const BUEHLER_KEY = 'buehler';
export const BUEHLER_COMPANY_NAME = 'Bühler Group';
export const BUEHLER_COMPANY_DOMAIN = 'buhlergroup.com';

const parser = createProspectiveChParser({
  companyKey: BUEHLER_KEY,
  companyName: BUEHLER_COMPANY_NAME,
  companyDomain: BUEHLER_COMPANY_DOMAIN,
  mediumId: '1008005',
  apiLang: 'de',
  defaultCanton: 'SG',
  defaultCity: 'Uzwil',
  defaultPostalCode: '9240',
  publicCareerUrl: 'https://jobs.buhlergroup.com/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.buhlergroup.com'],
});

export const fetchAllBuehlerJobs = parser.fetchAllJobs;
export const isBuehlerJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
