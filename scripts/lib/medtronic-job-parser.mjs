#!/usr/bin/env node
/**
 * Medtronic job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: medtronic.wd1.myworkdayjobs.com
 * Site path:   MedtronicCareers
 * Career URL:  https://jobs.medtronic.com/
 *
 * Medtronic is a global medtech leader (cardiac & vascular, medical-surgical,
 * neuroscience, diabetes). Swiss operations are concentrated in canton Vaud
 * (Tolochenaz manufacturing & Lausanne EMEA hub), with field roles across
 * the country.
 *
 * Usa la factory Workday condivisa (`createWorkdaySwissParser`): il luogo
 * pubblicato è la sede PRIMARIA della requisition letta dal dettaglio, mai
 * l'HQ. La copia locale che c'era qui ripiegava su `Tolochenaz` per ogni
 * roll-up «N Locations», pubblicando come vodesi vacancy primarie a Luzern,
 * Bern, Paris, Stockholm e Oslo (audit-parser-quality, issue 5253): lo stesso
 * difetto che la factory ha già chiuso per i suoi consumatori (2026-09-19).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMedtronicJobs() — Fetch and parse all Swiss jobs
 *   - isMedtronicJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to Medtronic / Workday tenant
 *   - MEDTRONIC_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const MEDTRONIC_KEY = 'medtronic';
export const MEDTRONIC_COMPANY_NAME = 'Medtronic';
export const MEDTRONIC_COMPANY_DOMAIN = 'medtronic.com';

const parser = createWorkdaySwissParser({
  companyKey: MEDTRONIC_KEY,
  companyName: MEDTRONIC_COMPANY_NAME,
  companyDomain: MEDTRONIC_COMPANY_DOMAIN,
  tenantHost: 'medtronic.wd1.myworkdayjobs.com',
  sitePath: 'MedtronicCareers',
  careerUrl: 'https://jobs.medtronic.com/',
  defaultCanton: 'VD',
  defaultCity: 'Tolochenaz',
  sector: 'Medtech / Dispositivi medici',
  defaultSourceLang: 'en',
});

export const fetchAllMedtronicJobs = parser.fetchAllJobs;
export const isMedtronicJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
