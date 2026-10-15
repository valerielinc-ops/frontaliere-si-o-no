#!/usr/bin/env node
/**
 * Universitäres Psychiatrisches Zentrum Bern (UPZ, formerly UPD — Universitäre
 * Psychiatrische Dienste Bern) job parser — Prospective.ch medium 1000842.
 *
 * UPD merged with Psychiatriezentrum Münsingen (PZM) into UPZ in 2026. The
 * old Umantis tenant 2908 still lists the vacancies, but every
 * `/Vacancies/{id}/Description/*` URL now 302-redirects to
 * https://jobs.upz-bern.ch/de/offene-stellen (measured 2026-09-29: 106/106),
 * so the Umantis factory quarantined every job and the crawler published
 * nothing (issue 5253). That page embeds the Prospective careercenter 1000842,
 * whose bundle reads `https://ohws.prospective.ch/public/v1/medium/1000842`:
 * 107 vacancies (UPZ sites in Bern, Münsingen, Biel, Burgdorf, Spiez and
 * Liebefeld), the same employer (the listing's first posting,
 * «Sozialarbeiter*in (m/w/d) als Mutterschaftsvertretung», is the one the
 * Umantis tenant published). The crawler now reads that medium through the
 * shared Prospective factory.
 *
 * Medium 1008606 (the former PZM medium, `pzm-muensingen-job-parser.mjs`) is a
 * different, smaller feed with other vacancy ids; it is not read here.
 *
 * `companyKey`, company name and the job slug formula
 * (`<title> upd <location>`) are unchanged, so the pages already published
 * keep their identity. The stored jobs still carry Umantis URLs: see
 * `bridgeUmantisUpdJobs` below.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';
import { slugify } from './crawler-template.mjs';

export const UPD_KEY = 'upd';
export const UPD_COMPANY_NAME = 'Universitäre Psychiatrische Dienste Bern (UPD)';
export const UPD_COMPANY_DOMAIN = 'upd.ch';
export const UPD_PROSPECTIVE_MEDIUM_ID = '1000842';

const UMANTIS_TENANT_HOST = 'recruitingapp-2908.umantis.com';

const parser = createProspectiveChParser({
  companyKey: UPD_KEY,
  companyName: UPD_COMPANY_NAME,
  companyDomain: UPD_COMPANY_DOMAIN,
  mediumId: UPD_PROSPECTIVE_MEDIUM_ID,
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3000',
  // Liebefeld is a locality of Köniz BE (UPZ site Waldeggstrasse 51d, 3097
  // Liebefeld): the BFS municipality registry does not resolve it on its own.
  siteCantons: { Liebefeld: 'BE' },
  publicCareerUrl: 'https://jobs.upz-bern.ch/de/offene-stellen',
  defaultSourceLang: 'de',
  // The stored jobs of the former Umantis tenant stay trusted while the merge
  // carries them over.
  extraTrustedHosts: ['jobs.upz-bern.ch', 'upz-bern.ch', 'upd.jobs', UMANTIS_TENANT_HOST],
  // The rendered vacancy page carries the posting with its own section
  // headings («Deine Aufgaben», «Dein Profil», «Das UPZ»; French postings in
  // French); the listing payload has no headings of its own and keeps raw
  // <br/> in the introduction. The listing text stays the per-job fallback.
  detailPageDescription: true,
});

export const fetchAllUpdJobs = parser.fetchAllJobs;
export const isUpdJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;

function bridgeKey(job) {
  return slugify(`${job?.title || ''} ${job?.location || job?.addressLocality || ''}`);
}

/**
 * Point the stored jobs of the retired Umantis tenant at the Prospective URL of
 * the same vacancy, so the merge (stable id from the URL) keeps their id and
 * slugs instead of retiring a published page and adding a new one. A stored
 * job is bridged only when its title + location matches exactly one fresh job
 * and that fresh job is claimed by no other stored job; the rest are left as
 * they are (the merge's miss grace retires them). Mutates the stored jobs.
 *
 * @param {object[]} storedJobs  this crawler's stored jobs
 * @param {object[]} freshJobs   this run's jobs from the Prospective medium
 * @returns {number} bridged jobs
 */
export function bridgeUmantisUpdJobs(storedJobs, freshJobs) {
  const freshByKey = new Map();
  for (const job of Array.isArray(freshJobs) ? freshJobs : []) {
    const key = bridgeKey(job);
    if (!key) continue;
    freshByKey.set(key, freshByKey.has(key) ? null : job);
  }
  const legacy = (Array.isArray(storedJobs) ? storedJobs : [])
    .filter((job) => String(job?.url || '').includes(UMANTIS_TENANT_HOST));
  const claims = new Map();
  for (const job of legacy) {
    const key = bridgeKey(job);
    claims.set(key, (claims.get(key) || 0) + 1);
  }
  let bridged = 0;
  for (const job of legacy) {
    const key = bridgeKey(job);
    const fresh = freshByKey.get(key);
    if (!fresh || claims.get(key) !== 1) continue;
    job.url = fresh.url;
    job.applyUrl = fresh.applyUrl || fresh.url;
    bridged += 1;
  }
  return bridged;
}
