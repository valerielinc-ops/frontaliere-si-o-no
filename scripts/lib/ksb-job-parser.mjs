#!/usr/bin/env node
/**
 * Kantonsspital Baden (KSB) job parser — Workday ATS.
 *
 * Tenant host: kantonsspitalbaden.wd3.myworkdayjobs.com
 * Site path:   ksb-careers (public, no `/en/` prefix needed at base level —
 *              the Workday client's `buildWorkdayApiBase` handles `/wday/cxs/`).
 *
 * Workday discovery (curl):
 *   curl https://kantonsspitalbaden.wd3.myworkdayjobs.com/de-DE/ksb-careers
 *
 * Public landing: https://www.ksb.ch/jobs-karriere/jobs (Next.js shell that
 *   pulls from Workday under the hood and surfaces the apply link to
 *   `kantonsspitalbaden.wd3.myworkdayjobs.com/ksb-careers/...`).
 *
 * KSB HQ: Im Ergel 1, 5404 Baden, AG.
 *
 * Workday returns `locationsCountry` facets; KSB only operates in
 * Switzerland so we leave the location filter empty (every posting is CH).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKsbJobs() — Fetch and parse all jobs
 *   - isKsbJob()        — Match jobs belonging to this company
 *   - isTrustedDomain() — Validate URLs belong to KSB / Workday tenant
 *   - KSB_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KSB_KEY = 'ksb';
export const KSB_COMPANY_NAME = 'Kantonsspital Baden (KSB)';
export const KSB_COMPANY_DOMAIN = 'ksb.ch';

const WORKDAY_TENANT_HOST = 'kantonsspitalbaden.wd3.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'ksb-careers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/de-DE/${WORKDAY_SITE_PATH}`;

const CAREER_URL = WORKDAY_PUBLIC_BASE;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isKsbJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KSB_KEY ||
    key.startsWith('kantonsspital-baden') ||
    company.includes('kantonsspital baden') ||
    company === 'ksb' ||
    url.includes('ksb.ch') ||
    url.includes('kantonsspitalbaden.wd3.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ksb.ch' ||
      host.endsWith('.ksb.ch') ||
      host === WORKDAY_TENANT_HOST ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme|nachtwache)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|doktorand|phd)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stationsleitung|oberarzt|chefarzt|executive)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Workday fetcher ───────────────────────────────────────── */

async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      // KSB only operates in Switzerland — no location filter needed.
      maxPages: 20,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase: WORKDAY_API_BASE, company: KSB_COMPANY_NAME });
      out.push({
        title: id.title,
        location: id.location,
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

export async function fetchAllKsbJobs() {
  console.log(`🏥 Fetching ${KSB_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Baden';
    const canton = inferSwissTargetCanton(location) || 'AG';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${KSB_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${KSB_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSB_COMPANY_NAME,
      companyKey: KSB_KEY,
      companyDomain: KSB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${KSB_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${KSB_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: `${KSB_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '5404',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${KSB_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
