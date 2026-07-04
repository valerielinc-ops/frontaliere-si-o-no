#!/usr/bin/env node
/**
 * Kantonale Verwaltung Basel-Landschaft job parser
 * — Prospective.ch medium 1571.
 *
 * Background:
 *   The cantonal administration of Basel-Landschaft (BL) is the canton's
 *   largest employer — five directorates, the Landeskanzlei and the courts,
 *   over 6'000 employees. Roles span education (Primarstufe/Sekundarstufe
 *   teachers), administration, HR, IT, police support, facility management
 *   and social services across the canton (Liestal, Binningen, Muttenz,
 *   Allschwil, and dozens of school districts). Confirmed via job-room.ch
 *   (~80 roles seen) and jobs.ch (30+ listed), part of issue #3342.
 *
 * Public career site: https://www.baselland.ch/politik-und-behorden/direktionen/
 *   finanz-und-kirchendirektion/personalamt/jobs/offene-stellen
 *   → backed by a Prospective careercenter (1571, "kt-bl" theme). The
 *     careercenter's Job-Abo page (ohws.prospective.ch/careercenter/1571/…)
 *     confirms the tenant; the public listing API returns real, currently
 *     open positions with direct-apply links on jobs.baselland.ch.
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1571/jobs?lang=de
 *   Verified live: total=50 open positions (2026-07-03), e.g.
 *   "HR Beraterin/HR Berater" (Liestal) —
 *   https://jobs.baselland.ch/offene-stellen/hr-beraterin-hr-berater/329b7caa-1fe1-47ef-a065-8f9845d6dd65
 *
 * Default canton BL, postal 4410 (Liestal, cantonal seat) — most postings
 * carry their own zip via `sza_location.zip` so this is a fallback only.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const KANTON_BASEL_LANDSCHAFT_KEY = 'kanton-basel-landschaft';
export const KANTON_BASEL_LANDSCHAFT_COMPANY_NAME = 'Kantonale Verwaltung Basel-Landschaft';
export const KANTON_BASEL_LANDSCHAFT_COMPANY_DOMAIN = 'baselland.ch';

const parser = createProspectiveChParser({
  companyKey: KANTON_BASEL_LANDSCHAFT_KEY,
  companyName: KANTON_BASEL_LANDSCHAFT_COMPANY_NAME,
  companyDomain: KANTON_BASEL_LANDSCHAFT_COMPANY_DOMAIN,
  mediumId: '1571',
  apiLang: 'de',
  defaultCanton: 'BL',
  defaultCity: 'Liestal',
  defaultPostalCode: '4410',
  publicCareerUrl: 'https://www.baselland.ch/politik-und-behorden/direktionen/finanz-und-kirchendirektion/personalamt/jobs/offene-stellen',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'baselland.ch',
    'jobs.baselland.ch',
  ],
});

export const fetchAllKantonBaselLandschaftJobs = parser.fetchAllJobs;
export const isKantonBaselLandschaftJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
