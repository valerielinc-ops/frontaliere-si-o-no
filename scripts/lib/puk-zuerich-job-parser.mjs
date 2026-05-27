#!/usr/bin/env node
/**
 * Psychiatrische Universitätsklinik Zürich (PUK) job parser — Refline ATS
 * tenant 163206 on apply.refline.ch.
 *
 * PUK Zürich is the psychiatric teaching hospital of the University of Zürich,
 * one of the largest mental-health employers in the canton (Erwachsenen-,
 * Alters-, Kinder- und Jugendpsychiatrie, Forensik, Konsiliar-/Liaisondienst).
 * The careers portal exposes ~90 open positions across nursing, medical,
 * therapy and support functions.
 *
 * Public career site:
 *   https://www.pukzh.ch/karriere/
 *   Refline portal: https://apply.refline.ch/163206/search.html
 *
 * Listing format: table-row
 *   <tr><td class="position"><a href=".../163206/{posId}/pub/{rev}/index.html">Title</a></td>
 *       <td class="department">…</td> …</tr>
 *
 * NOTE: PUK uses the bespoke listing path `search.html` (not `positions.html`).
 * The factory accepts a `listingPath` override.
 */
import { createReflineParser } from './refline-common.mjs';

export const PUK_ZUERICH_KEY = 'puk-zuerich';
export const PUK_ZUERICH_COMPANY_NAME = 'Psychiatrische Universitätsklinik Zürich';
export const PUK_ZUERICH_COMPANY_DOMAIN = 'pukzh.ch';

const parser = createReflineParser({
  reflineTenant: '163206',
  companyKey: PUK_ZUERICH_KEY,
  companyName: PUK_ZUERICH_COMPANY_NAME,
  companyDomain: PUK_ZUERICH_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8032',
  publicCareerUrl: 'https://www.pukzh.ch/karriere/',
  defaultSourceLang: 'de',
  listingHost: 'apply.refline.ch',
  listingPath: 'search.html',
  sector: 'Sanità / Ospedali',
  sourceLabel: 'PUK Zürich Dedicated Parser (Refline 163206)',
});

export const fetchAllPukZuerichJobs = parser.fetchAllJobs;
export const isPukZuerichJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
