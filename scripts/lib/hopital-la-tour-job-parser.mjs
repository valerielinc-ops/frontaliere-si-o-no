#!/usr/bin/env node
/**
 * Hôpital de La Tour (Meyrin) job parser.
 *
 * Public career site:  https://recrutement.latour.ch/
 * API:                 https://recrutement.latour.ch/api/offers (JSON)
 *
 * Private acute hospital in Meyrin (GE), member of Geneva clinic landscape.
 *
 * Uses the shared VD emploi platform parser (same Next.js careers app).
 */
import { createVdEmploiPlatformParser } from './vd-emploi-platform-common.mjs';

export const HOPITAL_LA_TOUR_KEY = 'hopital-la-tour';
export const HOPITAL_LA_TOUR_COMPANY_NAME = 'Hôpital de La Tour';
export const HOPITAL_LA_TOUR_COMPANY_DOMAIN = 'la-tour.ch';

const parser = createVdEmploiPlatformParser({
  companyKey: HOPITAL_LA_TOUR_KEY,
  companyName: HOPITAL_LA_TOUR_COMPANY_NAME,
  companyDomain: HOPITAL_LA_TOUR_COMPANY_DOMAIN,
  baseUrl: 'https://recrutement.latour.ch',
  defaultCanton: 'GE',
  defaultCity: 'Meyrin',
  defaultPostalCode: '1217',
  defaultSourceLang: 'fr',
  sourceLabel: 'Hôpital de La Tour Dedicated Parser (VD emploi platform)',
});

export const fetchAllHopitalLaTourJobs = parser.fetchAllJobs;
export const isHopitalLaTourJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
