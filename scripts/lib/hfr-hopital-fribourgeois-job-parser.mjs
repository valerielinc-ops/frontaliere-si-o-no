#!/usr/bin/env node
/**
 * Hôpital fribourgeois (HFR) / freiburger spital — Fribourg cantonal hospital.
 *
 * Public career portal (Drupal 10 brochure pages):
 *   https://www.h-fr.ch/le-reseau-hfr/nos-offres-demploi
 *   https://www.h-fr.ch/de/unser-spitalnetz/unsere-stellenangebote
 *
 * The brochure page links out to TWO Breezy HR boards:
 *   - https://hopital-fribourgeois.breezy.hr/   (main board, all positions)
 *   - https://assc-hes-apprentissage-hfr.breezy.hr/ (ASSC apprenticeships)
 *
 * Both expose the standard Breezy public JSON listing endpoint. We crawl the
 * main board only — the apprenticeship board is included indirectly when
 * the same hires get posted there. See
 * `scripts/lib/breezy-hr-common.mjs` for ATS details.
 */
import { createBreezyHrParser } from './breezy-hr-common.mjs';

export const HFR_KEY = 'hfr-hopital-fribourgeois';
export const HFR_COMPANY_NAME = 'Hôpital fribourgeois (HFR)';
export const HFR_COMPANY_DOMAIN = 'h-fr.ch';

const parser = createBreezyHrParser({
  companyKey: HFR_KEY,
  companyName: HFR_COMPANY_NAME,
  companyDomain: HFR_COMPANY_DOMAIN,
  breezyTenant: 'hopital-fribourgeois',
  defaultCanton: 'FR',
  defaultCity: 'Fribourg',
  defaultPostalCode: '1708',
  defaultSourceLang: 'fr',
  sourceLabel: 'HFR Hôpital fribourgeois Dedicated Parser (Breezy HR)',
  fallbackBrandBlurb:
    "L'Hôpital fribourgeois (HFR) est le réseau hospitalier public du canton de Fribourg. Il regroupe les sites de Fribourg, Riaz, Tafers, Meyriez-Murten et Billens, et emploie plus de 3'500 collaboratrices et collaborateurs.",
});

export const fetchAllHfrJobs = parser.fetchAllJobs;
export const isHfrJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
