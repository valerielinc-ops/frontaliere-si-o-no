#!/usr/bin/env node
/**
 * Hôpital Riviera-Chablais Vaud-Valais (HRC) job parser.
 *
 * Public career site:  https://emploi.hopitalrivierachablais.ch/
 * API:                 https://emploi.hopitalrivierachablais.ch/api/offers (JSON)
 *
 * Intercantonal hospital VD/VS, ~2'500 employees.
 * Sites: Rennaz (main acute), Aigle, Monthey, Vevey-Samaritain.
 *
 * Uses the shared VD emploi platform parser.
 */
import { createVdEmploiPlatformParser } from './vd-emploi-platform-common.mjs';

export const HRC_KEY = 'hrc';
export const HRC_COMPANY_NAME = 'Hôpital Riviera-Chablais (HRC)';
export const HRC_COMPANY_DOMAIN = 'hopitalrivierachablais.ch';

const parser = createVdEmploiPlatformParser({
  companyKey: HRC_KEY,
  companyName: HRC_COMPANY_NAME,
  companyDomain: HRC_COMPANY_DOMAIN,
  baseUrl: 'https://emploi.hopitalrivierachablais.ch',
  defaultCanton: 'VD',
  defaultCity: 'Rennaz',
  defaultPostalCode: '1847',
  defaultSourceLang: 'fr',
  sourceLabel: 'HRC Dedicated Parser (VD emploi platform)',
});

export const fetchAllHrcJobs = parser.fetchAllJobs;
export const isHrcJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
