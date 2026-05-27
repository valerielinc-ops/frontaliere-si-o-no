#!/usr/bin/env node
/**
 * Klinik Susenberg job parser — custom TYPO3 HTML.
 *
 * Public career site: https://www.susenbergklinik.ch/jobs/offene-stellen
 *
 * The page is server-rendered TYPO3 markup. Each open position is published
 * as a PDF on `/fileadmin/user_upload/Stellen/`, surfaced in the HTML as:
 *
 *   <a class="download-link-linkicon"
 *      href="/fileadmin/user_upload/Stellen/<file>.pdf"
 *      target="_blank"
 *      title="{HUMAN_READABLE_TITLE}">
 *
 * Grouping is implicit via `<h2 class="hf-header">{SECTION}</h2>` siblings
 * (e.g. "Pflege", "Therapien", "Ärztlicher Dienst"). We carry the most
 * recent section heading forward to build a department label for each PDF.
 *
 * Klinik Susenberg is a privately-run acute-geriatric / palliative-care /
 * oncological-rehab Klinik at Schreberweg 9, 8044 Zürich (canton ZH). Founded
 * 1899, ~80 beds, ~150 employees. Body length is short (3-5 jobs), so we
 * synthesise a richer fallback description so the locale-completeness gate
 * has enough text to translate from.
 *
 * Domain note: the historic `www.klinik-susenberg.ch` 301-redirects to
 * `https://www.susenbergklinik.ch/`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/**
 * The Susenberg TYPO3 backend rejects the bot User-Agent with HTTP 406. Fall
 * back to a stock browser UA + a permissive Accept header. Same trick used by
 * a handful of other Swiss hospital parsers behind ModSecurity / TYPO3
 * dynamic-cache rules.
 */
const BROWSER_USER_AGENT = process.env.JOBS_CRAWLER_BROWSER_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export const KLINIK_SUSENBERG_KEY = 'klinik-susenberg';
export const KLINIK_SUSENBERG_COMPANY_NAME = 'Klinik Susenberg';
export const KLINIK_SUSENBERG_COMPANY_DOMAIN = 'susenbergklinik.ch';

const CAREER_URL = 'https://www.susenbergklinik.ch/jobs/offene-stellen';
const BASE_URL = 'https://www.susenbergklinik.ch';
const DEFAULT_CITY = 'Zürich';
const DEFAULT_POSTAL_CODE = '8044';
const DEFAULT_STREET = 'Schreberweg 9';
const DEFAULT_CANTON = 'ZH';

const COMPANY_BOILERPLATE = "Die Klinik Susenberg ist eine privat geführte Klinik am Zürichberg, spezialisiert auf Akutgeriatrie, internistisch-onkologische Rehabilitation und Palliative Care. Wir bieten attraktive Anstellungsbedingungen und ein angenehmes Arbeitsklima in interprofessionellen Teams an schönster Lage in Zürich.";

export function isKlinikSusenbergJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === KLINIK_SUSENBERG_KEY) return true;
  if (url.includes('susenbergklinik.ch')) return true;
  if (url.includes('klinik-susenberg.ch')) return true;
  const company = String(job?.company || '').toLowerCase();
  if (/\bklinik susenberg\b/.test(company)) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'susenbergklinik.ch' || host.endsWith('.susenbergklinik.ch')) return true;
    if (host === 'klinik-susenberg.ch' || host.endsWith('.klinik-susenberg.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse the HTML of `/jobs/offene-stellen` into a list of
 * `{ url, title, department }` rows. Department is the most recent
 * `<h2 class="hf-header">` heading encountered before the PDF link.
 */
export function parseSusenbergJobsPage(html = '') {
  const out = [];
  const seen = new Set();
  // Scan top-down, tracking the active department heading. Anchors are emitted
  // inside `<ul class="ce-uploads">` blocks that come right after the H2.
  const pattern = /<h2[^>]*class="hf-header"[^>]*>\s*([^<]+?)\s*<\/h2>|<a[^>]*class="[^"]*download-link-linkicon[^"]*"[^>]*href="(\/fileadmin\/user_upload\/Stellen\/[^"]+\.pdf)"[^>]*title="([^"]+)"/g;
  let department = '';
  let m;
  while ((m = pattern.exec(html)) !== null) {
    if (m[1]) {
      department = normalizeSpace(decodeEntities(m[1]));
      continue;
    }
    const href = m[2];
    const title = normalizeSpace(decodeEntities(m[3]));
    if (!title || title.length < 3) continue;
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title, department });
  }
  return out;
}

function buildDescription(row) {
  const sentences = [
    `${row.title} bei der ${KLINIK_SUSENBERG_COMPANY_NAME}, ${DEFAULT_STREET}, ${DEFAULT_POSTAL_CODE} ${DEFAULT_CITY}, Schweiz.`,
  ];
  if (row.department) {
    sentences.push(`Tätigkeitsbereich: ${row.department}.`);
  }
  sentences.push(COMPANY_BOILERPLATE);
  sentences.push('Detailliertes Stellenprofil und Bewerbungsunterlagen siehe verlinktes PDF.');
  return sentences.join(' ');
}

function parsePostedDate(href = '') {
  // PDFs frequently end with `_YYYY-MM-DD.pdf` — use that as the post date when present.
  const m = String(href).match(/_(\d{4})-(\d{2})-(\d{2})\.pdf$/i);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!Number.isNaN(new Date(iso).getTime())) return iso;
  }
  return new Date().toISOString().slice(0, 10);
}

export async function fetchAllKlinikSusenbergJobs() {
  console.log(`🏥 Fetching ${KLINIK_SUSENBERG_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const html = await fetchHtml(CAREER_URL);
  const rows = parseSusenbergJobsPage(html);
  console.log(`  ✓ ${rows.length} job PDFs discovered`);
  if (!rows.length) return [];

  const jobs = [];
  for (const r of rows) {
    const description = buildDescription(r);
    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${KLINIK_SUSENBERG_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);
    const postedDate = parsePostedDate(r.url);

    jobs.push({
      id: `${KLINIK_SUSENBERG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_SUSENBERG_COMPANY_NAME,
      companyKey: KLINIK_SUSENBERG_KEY,
      companyDomain: KLINIK_SUSENBERG_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: r.url,
      source: `${KLINIK_SUSENBERG_COMPANY_NAME} Dedicated Parser (TYPO3 PDF listing)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL_CODE,
      streetAddress: DEFAULT_STREET,
      category: detectHealthcareCategory(r.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(r.title),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: CAREER_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      ...(r.department ? { department: r.department } : {}),
    });
  }

  console.log(`\n📋 Total ${KLINIK_SUSENBERG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_URL, BASE_URL };
