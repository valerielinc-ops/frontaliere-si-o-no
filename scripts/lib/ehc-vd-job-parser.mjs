#!/usr/bin/env node
/**
 * Ensemble hospitalier de la Côte (EHC) job parser.
 *
 * Public career site:  https://emploi.ehc-vd.ch/
 * API:                 https://emploi.ehc-vd.ch/api/offers (JSON)
 *
 * Operates 5 sites in canton Vaud (Morges + EMS + first-line medicine),
 * ~2'000 employees, ~40+ medical disciplines.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createVdEmploiPlatformParser } from './vd-emploi-platform-common.mjs';

export const EHC_VD_KEY = 'ehc-vd';
export const EHC_VD_COMPANY_NAME = 'Ensemble hospitalier de la Côte (EHC)';
export const EHC_VD_COMPANY_DOMAIN = 'ehc-vd.ch';

const parser = createVdEmploiPlatformParser({
  companyKey: EHC_VD_KEY,
  companyName: EHC_VD_COMPANY_NAME,
  companyDomain: EHC_VD_COMPANY_DOMAIN,
  baseUrl: 'https://emploi.ehc-vd.ch',
  defaultCanton: 'VD',
  defaultCity: 'Morges',
  defaultPostalCode: '1110',
  defaultSourceLang: 'fr',
  sourceLabel: 'EHC Dedicated Parser (VD emploi platform)',
});

export const fetchAllEhcVdJobs = parser.fetchAllJobs;
export const isEhcVdJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
