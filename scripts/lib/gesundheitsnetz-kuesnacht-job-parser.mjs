#!/usr/bin/env node
/**
 * Gesundheitsnetz Küsnacht AG (GNK) job parser — Refline ATS tenant 780392
 * on apply.refline.ch.
 *
 * GNK is the municipal care network of Küsnacht (ZH), running the Alters- und
 * Gesundheitszentren Tägerhalde and Wangensbach with ~130 residents plus a
 * Spitex service, day-care centre and a workshop programme. Open positions
 * span Pflege (Dipl. Pflegefachpersonen HF/FH, Fachfrau/Fachmann Gesundheit,
 * Pflegehelfer), Hotellerie/Küche and Lehrstellen.
 *
 * Public career site:
 *   https://www.gnk.ch/jobs/
 *   Refline portal: https://apply.refline.ch/780392/positions.html
 *
 * Listing format: table-row
 *   <tr><td class="position"><a href=".../780392/{posId}/pub/{rev}/index.html">Title</a></td>
 *       <td class="department">…</td> …</tr>
 */
import { createReflineParser } from './refline-common.mjs';

export const GESUNDHEITSNETZ_KUESNACHT_KEY = 'gesundheitsnetz-kuesnacht';
export const GESUNDHEITSNETZ_KUESNACHT_COMPANY_NAME = 'Gesundheitsnetz Küsnacht AG';
export const GESUNDHEITSNETZ_KUESNACHT_COMPANY_DOMAIN = 'gnk.ch';

const parser = createReflineParser({
  reflineTenant: '780392',
  companyKey: GESUNDHEITSNETZ_KUESNACHT_KEY,
  companyName: GESUNDHEITSNETZ_KUESNACHT_COMPANY_NAME,
  companyDomain: GESUNDHEITSNETZ_KUESNACHT_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Küsnacht',
  defaultPostalCode: '8700',
  publicCareerUrl: 'https://www.gnk.ch/jobs/',
  defaultSourceLang: 'de',
  listingHost: 'apply.refline.ch',
  sector: 'Sanità / Ospedali',
  sourceLabel: 'Gesundheitsnetz Küsnacht Dedicated Parser (Refline 780392)',
});

export const fetchAllGesundheitsnetzKuesnachtJobs = parser.fetchAllJobs;
export const isGesundheitsnetzKuesnachtJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
