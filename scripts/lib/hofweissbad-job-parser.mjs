#!/usr/bin/env node
/**
 * Resort Hof Weissbad job parser — jobs.ch company-page scraper.
 *
 * STATUS (2026-07-08): the own hofweissbad.ch/jobs Next.js landing page
 * (Vercel-hosted) sits behind a Vercel security checkpoint that 429s any
 * plain HTTP client; the previous approach drove a real Playwright browser
 * through the checkpoint to harvest `link.ostendis.com/publication/*`
 * anchors. That works in isolation, but on this host the on-demand
 * Chromium download/install races with every other worktree/agent sharing
 * `~/Library/Caches/ms-playwright`, repeatedly evicting a still-in-use
 * binary mid-crawl (observed: 100% download completes, browser launch never
 * gets a chance to run before the cache is thrashed by a sibling process) —
 * an environment-contention failure mode, not a bug in the Playwright logic
 * itself, but heavy/fragile for what should be a simple listing scrape.
 *
 * jobs.ch (TX Group), the public Swiss job board, publishes the same
 * openings server-rendered with zero anti-bot friction — confirmed live
 * 2026-07-08: company profile
 * `4716a540-19be-4788-a896-6594e6f9a5d7-hof-weissbad-ag` (the older numeric
 * `134218-hof-weissbad-ag` slug 301-redirects to it) lists "13 job offers"
 * and its `/vacancies/` sub-page renders every `/en/vacancies/detail/{uuid}/`
 * link with full `JobPosting` JSON-LD on each detail page (title,
 * jobLocation.address, hiringOrganization.name, datePosted, employmentType)
 * — same pattern already used by scripts/lib/visionapartments-job-parser.mjs
 * and scripts/lib/saint-gobain-weber-isover-job-parser.mjs. Switching to
 * this source drops the Playwright/Chromium dependency entirely for this
 * company.
 *
 * Hof Weissbad is a 4*+ resort + Gesundheitszentrum in Weissbad/Appenzell
 * Innerrhoden (AI). All jobs are Swiss; no further geographic filter needed.
 *
 * Exports the 4 functions required by the crawler template:
 * - fetchAllHofweissbadJobs() — Fetch and parse all jobs
 * - isHofweissbadJob() — Match jobs belonging to the company
 * - isTrustedDomain() — Validate URLs belong to the company / jobs.ch
 * - HOFWEISSBAD_KEY / HOFWEISSBAD_COMPANY_NAME / HOFWEISSBAD_COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { collectJobsChVacancyUrls, parseVacancyLinks } from './jobs-ch-company-pages.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOFWEISSBAD_KEY = 'hofweissbad';
export const HOFWEISSBAD_COMPANY_NAME = 'Resort Hof Weissbad';
export const HOFWEISSBAD_COMPANY_DOMAIN = 'hofweissbad.ch';


// Known jobs.ch company profile for Hof Weissbad AG. The older numeric
// `134218-hof-weissbad-ag` slug 301-redirects to this canonical UUID one —
// use the canonical path directly so the crawler doesn't depend on jobs.ch's
// redirect behavior staying stable.
const COMPANY_TARGETS = [
  {
    path: '4716a540-19be-4788-a896-6594e6f9a5d7-hof-weissbad-ag',
    label: 'Hof Weissbad AG',
  },
];

const DEFAULT_CITY = 'Weissbad';
const DEFAULT_CANTON = 'AI';
const DEFAULT_POSTAL = '9057';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ────────────────────────────────────────── */

export function isHofweissbadJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOFWEISSBAD_KEY ||
    /^hofweissbad(-|$)/.test(key) ||
    /^resort-?hof-?weissbad/.test(key) ||
    company.includes('hof weissbad') ||
    company.includes('hofweissbad') ||
    url.includes('hofweissbad.ch') ||
    /ostendis\.com\/publication\//.test(url)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hofweissbad.ch' || host.endsWith('.hofweissbad.ch')) return true;
    if (host === 'jobs.ch' || host === 'www.jobs.ch' || host.endsWith('.jobs.ch')) return true;
    // Ostendis hosted the previous canonical apply pages — keep trusted in
    // case any stale stored jobs still reference it.
    if (host === 'link.ostendis.com' || host === 'odm.ostendis.com') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category detection ───────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(koch|k[oö]chin|chef.?de.?partie|patissier|cuisine|kitchen|sous.?chef|kuchen)/.test(t)) return 'Ristorazione';
  if (/\b(service|sommelier|barkeeper|barista|restaurant|kellner|maitre)/.test(t)) return 'Ristorazione';
  if (/\b(reinig|hauswirtschaft|housekeep|room attendant|zimmerm|hotelfach)/.test(t)) return 'Ospitalità';
  if (/\b(reception|empfang|concierge|front office|guest relations)/.test(t)) return 'Ospitalità';
  if (/\b(pflege|therap|physio|arzt|medizin|gesundheit|wellness|beauty|spa|kosmetik)/.test(t)) return 'Sanità';
  if (/\b(technik|handwerk|elektrik|haustechnik|unterhalt|facility)/.test(t)) return 'Ingegneria';
  if (/\b(verkauf|sales|marketing|kommunik)/.test(t)) return 'Marketing';
  if (/\b(hr\b|human resources|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(admin|büro|office|assist|buchhalt|finanz)/.test(t)) return 'Amministrazione';
  if (/\b(lehrling|lernend|apprenti|praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|trainee)/.test(t)) return 'Formazione';
  return 'Ospitalità';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
  }
  if (/\b(teilzeit|part.?time|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|lehrling|lernend|apprenti)/.test(t)) return 'INTERN';
  if (/\b(aushilfe|temporary|tempor|befristet|fixed.?term)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|ausbildung|trainee)/i.test(t)) return 'intern';
  if (/junior|jr\b/i.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|dirett|chef|verantwort|responsab|leiter|manager/i.test(t)) return 'senior';
  return 'mid';
}

/* ── Listing pages ─────────────────────────────────────────────── */

// Re-exported from the shared jobs.ch reader so the company-page crawlers
// cannot drift apart on the link shape (AGENTS.md #6).
export { parseVacancyLinks };

/* ── Detail page parser ───────────────────────────────────────── */

export function extractJobPostingJsonLd(html = '') {
  if (!html) return null;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj['@type'] === 'JobPosting' || (Array.isArray(obj) && obj.find((o) => o && o['@type'] === 'JobPosting')))) {
        return Array.isArray(obj) ? obj.find((o) => o && o['@type'] === 'JobPosting') : obj;
      }
    } catch {
      // try next script block
    }
  }
  return null;
}

/* ── Main fetch function ────────────────────────────────────────── */

/**
 * Fetch all Hof Weissbad jobs published on jobs.ch.
 *
 * Pipeline:
 *   1. GET the jobs.ch company `/vacancies/` sub-page and harvest every
 *      `/en/vacancies/detail/{uuid}/` link.
 *   2. GET each detail page and extract the `JobPosting` JSON-LD block.
 *   3. Build a ParsedJob per result (default canton AI, city Weissbad,
 *      overridden by the detail page's own address when present).
 *
 * IMPORTANT: Only source-locale (`de`) fields are populated here; other
 * locales are filled by the shared AI localization step.
 */
export async function fetchAllHofweissbadJobs({ fetchPage = fetchHtml } = {}) {
  console.log('🏢 Fetching Hof Weissbad jobs from jobs.ch company page');

  const { vacancyUrls, provenEmpty, evidence } = await collectJobsChVacancyUrls(
    COMPANY_TARGETS,
    { fetchPage, pathSuffix: 'vacancies/' },
  );

  if (!vacancyUrls.length) {
    console.warn('⚠️ No Hof Weissbad vacancy URLs found on jobs.ch');
    if (!provenEmpty) return [];
    console.log(`  🧩 Source-proven zero: ${evidence}`);
    return markAuthoritativeEmptySnapshot([], evidence);
  }

  console.log(`  📋 Total unique vacancy URLs: ${vacancyUrls.length}\n`);

  const jobs = [];
  for (const jobUrl of vacancyUrls) {
    let posting = null;
    try {
      const detailHtml = await fetchHtml(jobUrl);
      posting = extractJobPostingJsonLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${jobUrl}: ${err?.message || err}`);
    }
    if (!posting) continue;

    const title = decodeEntities(posting.title || '').trim();
    if (!title) continue;

    const addr = posting.jobLocation?.address || {};
    const city = decodeEntities(addr.addressLocality || addr.addressRegion || '').trim() || DEFAULT_CITY;
    const postalCode = String(addr.postalCode || '').trim() || DEFAULT_POSTAL;
    const canton = DEFAULT_CANTON;
    const country = 'CH';

    let description = stripHtml(posting.description || '');
    if (description.length < 80) {
      description =
        `${title} — Stelle im Resort Hof Weissbad in ${city} (${canton}), Schweiz. ` +
        `Das 4-Sterne-Plus Resort Hof Weissbad ist ein innovatives Hotel- und Gesundheitszentrum mit rund 270 Mitarbeitenden im Appenzellerland.`;
    }

    const hiringOrg = decodeEntities(posting.hiringOrganization?.name || '').trim();
    const employmentTypeRaw = Array.isArray(posting.employmentType)
      ? posting.employmentType[0]
      : posting.employmentType;

    const postedDate = (() => {
      const raw = posting.datePosted;
      if (!raw) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })();

    let validThrough;
    if (posting.validThrough) {
      const vd = new Date(posting.validThrough);
      if (!Number.isNaN(vd.getTime())) validThrough = vd.toISOString().slice(0, 10);
    }

    const sourceLang = detectLang(`${title} ${description}`, 'de');
    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} hof weissbad ${city}`);
    const employmentType = String(employmentTypeRaw || '').toUpperCase() || detectEmploymentType(title);

    jobs.push({
      id: `${HOFWEISSBAD_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || HOFWEISSBAD_COMPANY_NAME,
      companyKey: HOFWEISSBAD_KEY,
      companyDomain: HOFWEISSBAD_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'Hof Weissbad Dedicated Parser (jobs.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: country,
      country,
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Hôtellerie / Sanità',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: jobUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 60)} — ${city}`);
  }

  console.log(`\n📋 Total unique Hof Weissbad jobs discovered: ${jobs.length}`);
  return jobs;
}
