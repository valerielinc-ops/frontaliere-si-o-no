#!/usr/bin/env node
/**
 * Equans Switzerland job parser — Prospective.ch (medium 1004089).
 *
 * Public career site: https://equans.ch/de/menschen-karriere/offene-stellen
 * API:                 https://ohws.prospective.ch/public/v1/medium/1004089/jobs
 *
 * MIGRATED off jobs.ch (2026-08-25) — a prior `@outsourced-ats-confirmed`
 * claim on this file said equans.ch's career page delegates to jobs.ch/
 * jobup.ch tabs, so jobs.ch was Equans's real channel. That was wrong: it
 * was read off a static fetch of the career page, and its "zwei Jobportalen"
 * text was misinterpreted as "jobs.ch/jobup.ch" without checking what the
 * two portals actually were. A real browser found the page instead embeds
 * `https://ohws.prospective.ch/public/v1/careercenter/1004089/` directly —
 * Equans's own Prospective.ch tenant, not an aggregator — with 122 live
 * listings (confirmed via `curl
 * https://ohws.prospective.ch/public/v1/medium/1004089/jobs?lang=de`).
 * jobs.ch was never Equans's real primary channel; this parser was scraping
 * it instead of the direct source that was there the whole time. This file
 * no longer imports any jobs.ch/jobup.ch client, so the aggregator-source
 * gate (`tests/aggregator-sourced-crawler-gate.test.ts`) no longer applies
 * to it.
 *
 * Equans Switzerland is the Swiss arm of Equans (Bouygues group), a
 * facility-management / technical-services group (HVAC, electrical,
 * maintenance, energy) with ~6500 own staff in Switzerland. Confirmed
 * GENUINE DIRECT EMPLOYER, not a staffing/placement agency — `attributes.50`
 * (hiring subsidiary) on every listing varies only across legitimate
 * Equans-group entities (Equans Switzerland AG, Equans Switzerland Facility
 * Management AG, Caliqua AG — an HVAC company acquired by Equans), and
 * `sza_apply_link` routes to Equans's own SuccessFactors career site
 * (career55.sapsf.eu/career?company=equans), confirming Prospective.ch here
 * is a listing/display layer over Equans's own ATS, not a third party.
 *
 * Postings span 14+ cantons (multi-site group, not single-location).
 *
 * HQ fallback address (jobs.ch company profile, unaffected by the source
 * migration): Förrlibuckstrasse 150, 8005 Zürich, ZH.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const EQUANS_KEY = 'equans';
export const EQUANS_COMPANY_NAME = 'Equans Switzerland';
export const EQUANS_COMPANY_DOMAIN = 'equans.ch';

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(montage|installat|elektro|sanit[aä]r|heizung|k[aä]lte|l[uü]ftung|schaltanlage)/.test(t)) return 'Tecnica';
  if (/\b(facility|property|liegenschaft|geb[aä]udetechnik|hauswart)/.test(t)) return 'Facility Management';
  if (/\b(projektleit|chef de projet|project manager|capo progetto)/.test(t)) return 'Project Management';
  if (/\b(lernend|lehre|apprenti|stagiair|praktik)/.test(t)) return 'Formazione';
  if (/\b(it\b|software|develop|programm|cad|cae)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(vertrag|contract|contrat|contabilit[aà]|comptab|buchhalt)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

const parser = createProspectiveChParser({
  companyKey: EQUANS_KEY,
  companyName: EQUANS_COMPANY_NAME,
  companyDomain: EQUANS_COMPANY_DOMAIN,
  mediumId: '1004089',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8005',
  defaultStreetAddress: 'Förrlibuckstrasse 150',
  publicCareerUrl: 'https://equans.ch/de/menschen-karriere/offene-stellen',
  defaultSourceLang: 'de',
  sector: 'Facility Management / Impiantistica',
  categoryFn: detectCategory,
});

export const fetchAllEquansJobs = parser.fetchAllJobs;
export const isEquansJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
