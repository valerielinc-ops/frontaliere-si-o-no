#!/usr/bin/env node
/**
 * Adullam-Stiftung Basel & Riehen job parser — Solique board.
 *
 * Live source:   https://live.solique.ch/adullam/   (Solique recruiting board, flat SSR)
 * Public career: https://www.adullam.ch/stellen-karriere/offene-stellen
 *                (embeds the Solique board in an iframe)
 *
 * Migrated off Umantis: the old tenant 2562 listing still answers but its
 * `/Vacancies/{id}/Description/1` page now 302-redirects to the public site
 * (issue #1245), and the Solique board carries a DIFFERENT, current job set with
 * real server-rendered descriptions. So Solique is now the source of truth and we
 * crawl it directly via the shared `createSoliqueParser` (same module as
 * spital-emmental / oberengadin / svar).
 *
 * Geriatric / palliative care foundation operating a Spital + Pflegezentrum in
 * Basel and Riehen.
 */
import { createSoliqueParser } from './solique-common.mjs';

export const ADULLAM_KEY = 'adullam';
export const ADULLAM_COMPANY_NAME = 'Adullam-Stiftung';
export const ADULLAM_COMPANY_DOMAIN = 'adullam.ch';

const parser = createSoliqueParser({
  soliqueTenant: 'adullam',
  companyKey: ADULLAM_KEY,
  companyName: ADULLAM_COMPANY_NAME,
  companyDomain: ADULLAM_COMPANY_DOMAIN,
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4054',
  publicCareerUrl: 'https://www.adullam.ch/stellen-karriere/offene-stellen',
  defaultSourceLang: 'de',
});

export const fetchAllAdullamJobs = parser.fetchAllJobs;
export const isAdullamJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
