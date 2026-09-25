#!/usr/bin/env node
/**
 * Universität Zürich (UZH) job parser — Prospective.ch (medium 1002007).
 *
 * UZH is the largest university in Switzerland. Its public job portal
 * (https://jobs.uzh.ch/) embeds a Prospective.ch careercenter; the careercenter
 * ID matches the Prospective v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1002007/jobs?lang=de
 *
 * All postings are in canton Zürich (academic, research, administrative, clinical
 * roles). Canton ZH, postal 8001 (Rämistrasse 71, Zürich).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const UZH_KEY = 'uzh';
export const UZH_COMPANY_NAME = 'Universität Zürich';
export const UZH_COMPANY_DOMAIN = 'uzh.ch';

const parser = createProspectiveChParser({
  companyKey: UZH_KEY,
  companyName: UZH_COMPANY_NAME,
  companyDomain: UZH_COMPANY_DOMAIN,
  mediumId: '1002007',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8001',
  publicCareerUrl: 'https://jobs.uzh.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.uzh.ch'],
});

export const fetchAllUzhJobs = parser.fetchAllJobs;
export const isUzhJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
