#!/usr/bin/env node
/**
 * Fachspital Sune-Egge (Stiftung Sozialwerk Pfarrer Sieber) — Personio ATS.
 *
 * Source:
 *   - Career site: https://swsieber.jobs.personio.com/
 *   - JSON feed:   https://swsieber.jobs.personio.com/search.json?language=de
 *   - Detail:      https://swsieber.jobs.personio.com/job/{id}
 *
 * Fachspital Sune-Egge is a niche Swiss specialty clinic in Zürich
 * (8005) caring for late-stage addiction patients with co-morbid
 * infectious disease (HIV/HCV) — part of Stiftung Sozialwerk Pfarrer
 * Sieber (SWS). Its job postings flow through the SWS-wide Personio
 * tenant (`swsieber`); we filter to `office === "Fachspital Sune-Egge"`
 * so we don't mis-claim Notschlafstelle Nemo / Pfarrer-Sieber-Haus /
 * Geschäftsstelle postings.
 *
 * Personio ships an unauthenticated `/search.json` endpoint that returns
 * the same payload the careers SPA hydrates from. Each job carries a
 * full HTML `description`, `employment_type`, `schedule`, `office`,
 * `department`. We synthesise the canonical detail URL as
 * `/job/{id}` (Personio resolves this to the per-locale slug).
 *
 * Re-discovery note (2026-05-20): batch-21 probed `sune-egge.ch`
 * (NXDOMAIN). The clinic does not run its own domain — the Sozialwerk
 * publishes all jobs via `swsieber.jobs.personio.com` (linked from
 * `https://www.swsieber.ch/jobs/`).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

export const SUNE_EGGE_KEY = 'sune-egge';
export const SUNE_EGGE_COMPANY_NAME = 'Fachspital Sune-Egge';
export const SUNE_EGGE_COMPANY_DOMAIN = 'swsieber.ch';

const PERSONIO_API_URL = 'https://swsieber.jobs.personio.com/search.json?language=de';
const CAREER_URL = 'https://www.swsieber.ch/jobs/';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DEFAULT_CITY = 'Zürich';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8005';
const TARGET_OFFICE = 'Fachspital Sune-Egge';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function isSuneEggeJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SUNE_EGGE_KEY ||
    /^sune-?egge/.test(key) ||
    /sune.?egge/.test(company) ||
    url.includes('swsieber.jobs.personio.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'swsieber.jobs.personio.com') return true;
    if (host === 'swsieber.ch' || host.endsWith('.swsieber.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|fage|fa-?gesundheit|gesundheits|pfleger|krankenschwester|krankenpfleger|fachfrau|fachmann|efz|efa)/.test(t)) return 'Sanità';
  if (/\b(arzt|aerztin|ärztin|medizin|physiotherap|ergotherap|psychotherap|facharzt)/.test(t)) return 'Sanità';
  if (/\b(therapeut|therapie|logoped)/.test(t)) return 'Sanità';
  if (/\b(koch|k[oö]chin|chef.?de.?partie|cuisine|kitchen|sous.?chef)/.test(t)) return 'Ristorazione';
  if (/\b(sozialarbeit|sozialpaedagog|sozialpädagog|peer|seelsorg)/.test(t)) return 'Sociale';
  if (/\b(verwalt|admin|sekretär|bookkeep|buchhalt|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(lehrling|lernend|apprenti|praktik|intern)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|intern|trainee|aushilfe|vorpraktikant)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|chef|leiter|leitend|head|director|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*\d{2,3}\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/\b(part.?time|teilzeit)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern|stage|lehrling|lernend)/.test(t)) return 'INTERN';
  if (/\b(stundenlohn|aushilfe|befristet)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

async function fetchJson(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildParsedJob(rec) {
  const title = normalizeSpace(rec.name || '');
  if (!title || title.length < 3) return null;
  const office = String(rec.office || '');
  if (office !== TARGET_OFFICE) return null;

  const descHtml = String(rec.description || '');
  const descText = stripHtml(descHtml);
  const sourceLang = detectLang(descText || title, 'de');

  const publicUrl = `https://swsieber.jobs.personio.com/job/${rec.id}`;
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} sune egge zurich`);

  const fallbackDesc =
    `${title} — Stelle im Fachspital Sune-Egge in ${DEFAULT_CITY} (${DEFAULT_CANTON}), Schweiz. ` +
    'Das Fachspital Sune-Egge der Stiftung Sozialwerk Pfarrer Sieber (SWS) betreut suchtmittelabhängige ' +
    'Menschen mit komplexen Begleiterkrankungen (HIV / HCV) — eine in der Schweiz einzigartige Spezialklinik im Sozialwesen.';
  const desc = descText.length >= 80 ? descText : fallbackDesc;

  const postedDate = new Date().toISOString().slice(0, 10);
  const employmentBasis = `${title} ${rec.schedule || ''} ${rec.employment_type || ''}`;

  return {
    id: `sune-egge-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: SUNE_EGGE_COMPANY_NAME,
    companyKey: SUNE_EGGE_KEY,
    companyDomain: SUNE_EGGE_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: DEFAULT_CITY,
    canton: DEFAULT_CANTON,
    url: publicUrl,
    source: 'Fachspital Sune-Egge Dedicated Parser (Personio JSON)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: DEFAULT_CITY,
    addressRegion: DEFAULT_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: DEFAULT_POSTAL,
    category: detectCategory(title),
    contract: detectEmploymentType(employmentBasis) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(employmentBasis),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Sanità',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    needsRetranslation: true,
  };
}

export async function fetchAllSuneEggeJobs() {
  console.log(`🔍 Fetching Fachspital Sune-Egge jobs (Personio)`);
  console.log(`   Career:  ${CAREER_URL}`);
  console.log(`   API:     ${PERSONIO_API_URL}`);
  console.log(`   Filter:  office === "${TARGET_OFFICE}"\n`);

  let records = [];
  try {
    records = await fetchJson(PERSONIO_API_URL);
  } catch (err) {
    console.warn(`⚠️ Personio search.json fetch failed: ${err?.message || err}`);
    return [];
  }
  if (!Array.isArray(records)) {
    console.warn(`⚠️ Personio search.json: expected array, got ${typeof records}`);
    return [];
  }
  console.log(`   Total tenant openings: ${records.length}`);

  const jobs = [];
  for (const rec of records) {
    try {
      const job = buildParsedJob(rec);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`⚠️ Skipping id=${rec?.id || '<?>'}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total Fachspital Sune-Egge jobs discovered: ${jobs.length}`);
  return jobs;
}
