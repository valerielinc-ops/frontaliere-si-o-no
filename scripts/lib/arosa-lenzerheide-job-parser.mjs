#!/usr/bin/env node
/**
 * Arosa Lenzerheide job parser — Refline ATS tenant 3316 on
 * app.reflinejobs.io (Lenzerheide Bergbahnen AG job board).
 *
 * BLIND-SCAFFOLD FIX (issue #3891, 2026-07): the original parser targeted
 * https://www.arosalenzerheide.swiss/de/Jobs — a URL that returns HTTP 404
 * and, per git history, never existed (the crawler never produced a single
 * job: lastSuccessfulRunAt=null since creation). Live re-discovery:
 *
 *   - Real jobs hub: https://arosalenzerheide.swiss/de/Skigebiet/Jobs
 *     (Pimcore destination portal — a hub page only, no listings itself).
 *     It links to the two operating companies of the ski resort:
 *
 *   - Lenzerheide Bergbahnen AG
 *     /de/Skigebiet/Bergbahnen/Unternehmen/Lenzerheide-Bergbahnen-AG/Jobs-LBB
 *     → embeds Refline widget https://app.reflinejobs.io/3316/refline.js
 *     → server-rendered listing (anchor-list + workName template):
 *       https://app.reflinejobs.io/3316/positions.html?lang=de
 *     Confirmed live 2026-07-11: 5 open positions
 *     (e.g. "Betriebselektriker:in", ".../3316/0012/pub/9/index.html",
 *     detail page ships `<h1 class="posTitle">`).  ← THIS parser's source.
 *
 *   - Arosa Bergbahnen AG
 *     /de/Skigebiet/Bergbahnen/Unternehmen/Arosa-Bergbahnen-AG/Jobs-ABB
 *     → embeds a Yousty/professional.ch JS widget (`Yousty.Job({...})`,
 *     apiHost https://api.professional.ch, AES-encrypted authKey decrypted
 *     only inside lazily-loaded widget chunks; professional.ch robots.txt
 *     disallows /api and /widgets). NOT crawlable server-side without
 *     reverse-engineering the widget auth — deliberately out of scope; the
 *     Refline board above is the crawlable source for this companyKey.
 *
 * Listing format: anchor-list + workName (Pigna-style)
 *   <div class="listblock listcontent">
 *     <a href="https://app.reflinejobs.io/3316/{posId}/pub/{rev}/index.html">Title</a>
 *     <div class="item workName">Lenzerheide Bergbahnen AG</div>
 *
 * The `workName` column carries the operating company (not a city), so a
 * custom `locationHintsFor` maps it onto the two resort municipalities
 * (Lenzerheide/Vaz-Obervaz GR 7078, Arosa GR 7050) instead of the factory's
 * default city-name canton inference.
 */
import { createReflineParser } from './refline-common.mjs';

export const AROSA_LENZERHEIDE_KEY = 'arosa-lenzerheide';
export const AROSA_LENZERHEIDE_COMPANY_NAME = 'Arosa Lenzerheide';
export const AROSA_LENZERHEIDE_COMPANY_DOMAIN = 'arosalenzerheide.swiss';

const REFLINE_TENANT = '3316';

const parser = createReflineParser({
  reflineTenant: REFLINE_TENANT,
  companyKey: AROSA_LENZERHEIDE_KEY,
  companyName: AROSA_LENZERHEIDE_COMPANY_NAME,
  companyDomain: AROSA_LENZERHEIDE_COMPANY_DOMAIN,
  defaultCanton: 'GR',
  defaultCity: 'Lenzerheide',
  defaultPostalCode: '7078',
  publicCareerUrl: 'https://arosalenzerheide.swiss/de/Skigebiet/Jobs',
  defaultSourceLang: 'de',
  listingHost: 'app.reflinejobs.io',
  sector: 'Turismo / Ospitalità',
  sourceLabel: `Arosa Lenzerheide Dedicated Parser (Refline ${REFLINE_TENANT})`,
  // Free-text company matches: the corporate-domain first label
  // ("arosalenzerheide") never appears in the display name "Arosa
  // Lenzerheide" (space-separated), so the factory default substring check
  // would miss existing jobs. Also match the two operating companies.
  companyNameMatch: (company) =>
    company.includes('arosa lenzerheide') ||
    company.includes('arosalenzerheide') ||
    company.includes('lenzerheide bergbahnen') ||
    company.includes('arosa bergbahnen'),
  // workName is the operating company, not a city: map onto the resort
  // municipality. Default = Lenzerheide (tenant 3316 is the LBB board).
  locationHintsFor: (workplace = '') => {
    const wp = String(workplace || '').toLowerCase();
    if (wp.includes('arosa')) return { city: 'Arosa', canton: 'GR', postal: '7050' };
    return { city: 'Lenzerheide', canton: 'GR', postal: '7078' };
  },
});

export const fetchAllArosaLenzerheideJobs = parser.fetchAllJobs;
export const isArosaLenzerheideJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
