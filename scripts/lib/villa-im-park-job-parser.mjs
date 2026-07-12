#!/usr/bin/env node
/**
 * Privatklinik Villa im Park (Rothrist, AG) — SmartRecruiters tenant
 * `SwissMedicalNetwork1`, filtered to the "Privatklinik Villa im Park" brand.
 *
 * Source:
 *   - Career landing:  https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKV
 *   - List API:        https://api.smartrecruiters.com/v1/companies/SwissMedicalNetwork1/postings
 *   - Detail API:      https://api.smartrecruiters.com/v1/companies/SwissMedicalNetwork1/postings/{id}
 *   - Apply page:      https://jobs.smartrecruiters.com/SwissMedicalNetwork1/{id}-{slug}
 *
 * The Swiss Medical Network parent crawler (`swiss-medical-network-job-parser.mjs`)
 * is intentionally Ticino-only — Villa im Park sits in Rothrist (AG, 4852)
 * and never matched that filter. We split it out into its own dedicated
 * crawler so the German-Switzerland AG/SO catchment surfaces for Permit-B
 * commuters from the Solothurn / Olten side.
 *
 * Filter logic: SmartRecruiters' public API does not honour `customField`
 * querystring filters for unauthenticated callers, so we fetch all
 * ~90 SwissMedicalNetwork postings (paginated `limit=100`) and keep only
 * those whose `customField` has `fieldLabel === "Brands"` and
 * `valueId === "PKV"`. (The brand identifier is stable across the SR
 * tenant — see /de/karriere/stellenangebote?clinic=PKV.)
 *
 * Re-discovery note (2026-05-20): batch-21 originally probed
 * `villa-im-park.ch` (NXDOMAIN). The clinic does not run its own
 * domain — Swiss Medical Network hosts it at
 * `swissmedical.net/de/spitaeler/villa-im-park` with the brand-scoped
 * SmartRecruiters search above.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

export const VILLA_IM_PARK_KEY = 'villa-im-park';
export const VILLA_IM_PARK_COMPANY_NAME = 'Privatklinik Villa im Park';
export const VILLA_IM_PARK_COMPANY_DOMAIN = 'swissmedical.net';

const SMARTRECRUITERS_COMPANY = 'SwissMedicalNetwork1';
const BRAND_VALUE_ID = 'PKV';
const LIST_URL_BASE = `https://api.smartrecruiters.com/v1/companies/${SMARTRECRUITERS_COMPANY}/postings`;
const CAREER_URL = 'https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKV';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DEFAULT_CITY = 'Rothrist';
const DEFAULT_CANTON = 'AG';
const DEFAULT_POSTAL = '4852';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function isVillaImParkJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VILLA_IM_PARK_KEY ||
    /villa-?im-?park/.test(key) ||
    /villa im park/.test(company) ||
    url.includes('clinic=pkv') ||
    /jobs\.smartrecruiters\.com\/swissmedicalnetwork1\//i.test(url)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'swissmedical.net' || host.endsWith('.swissmedical.net')) return true;
    if (host === 'jobs.smartrecruiters.com') return true;
    if (host === 'api.smartrecruiters.com') return true;
    return false;
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|fage|fa-?gesundheit|gesundheits|pfleger|krankenschwester|krankenpfleger|fachfrau|fachmann|efz|efa|anaesth|anästh)/.test(t)) return 'Sanità';
  if (/\b(arzt|aerztin|ärztin|medizin|physiotherap|ergotherap|psychotherap|facharzt|chirurg)/.test(t)) return 'Sanità';
  if (/\b(therapeut|therapie|logoped|hebamme)/.test(t)) return 'Sanità';
  if (/\b(koch|k[oö]chin|cuisine|kitchen)/.test(t)) return 'Ristorazione';
  if (/\b(verwalt|admin|sekretär|empfang|bookkeep|buchhalt|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(it|edv|netzwerk|system|software)/.test(t)) return 'IT';
  if (/\b(lehrling|lernend|apprenti|praktik|intern|studium|studi[oe])/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|intern|trainee|aushilfe|studium|lehrstelle|studi[oe])/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|chef|leiter|leitend|head|director|responsab|expert)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', srType = '') {
  const t = normalize(`${title} ${srType}`);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*\d{2,3}\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/full-?time|vollzeit/.test(t)) return 'FULL_TIME';
  if (/part-?time|teilzeit/.test(t)) return 'PART_TIME';
  if (/praktik|intern|stage|lehrling|lernend|studium/.test(t)) return 'INTERN';
  if (/aushilfe|temporary|tempor|befristet/.test(t)) return 'CONTRACTOR';
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

function isPKVBrand(posting) {
  const cf = Array.isArray(posting?.customField) ? posting.customField : [];
  return cf.some((f) => normalize(f.fieldLabel) === 'brands' && String(f.valueId) === BRAND_VALUE_ID);
}

function sectionsToHtml(sections) {
  if (!sections || typeof sections !== 'object') return '';
  const order = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];
  const parts = [];
  for (const k of order) {
    const sec = sections[k];
    if (!sec || typeof sec !== 'object') continue;
    if (sec.title) parts.push(`<h3>${sec.title}</h3>`);
    if (sec.text) parts.push(sec.text);
  }
  return parts.join('\n');
}

function buildParsedJob(posting, detail) {
  const title = normalizeSpace(posting.name || '');
  if (!title || title.length < 3) return null;

  const detailSections = detail?.jobAd?.sections || posting?.jobAd?.sections;
  const descHtml = sectionsToHtml(detailSections);
  const descText = stripHtml(descHtml);
  const sourceLang = detectLang(descText || title, 'de');

  const city = posting?.location?.city || DEFAULT_CITY;
  const canton = posting?.location?.region || DEFAULT_CANTON;
  const postalCode = posting?.location?.postalCode || DEFAULT_POSTAL;
  const street = posting?.location?.address || '';
  const country = (posting?.location?.country || 'ch').toUpperCase();

  if (country !== 'CH') return null;

  // Canonical apply URL on jobs.smartrecruiters.com
  const publicUrl =
    detail?.applyUrl
    || detail?.postingUrl
    || `https://jobs.smartrecruiters.com/${SMARTRECRUITERS_COMPANY}/${posting.id}`;
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} villa im park rothrist`);

  const fallbackDesc =
    `${title} — Stelle in der Privatklinik Villa im Park in ${city} (${canton}), Schweiz. ` +
    'Die Privatklinik Villa im Park gehört zum Swiss Medical Network und bietet ein breites Spektrum an chirurgischen, orthopädischen und konservativen Behandlungen für Halb- und Privatpatientinnen und -patienten an.';
  const desc = descText.length >= 80 ? descText : fallbackDesc;

  const postedDate = (() => {
    const raw = posting.releasedDate || detail?.releasedDate;
    if (!raw) return new Date().toISOString().slice(0, 10);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  })();

  const srType = posting?.typeOfEmployment?.label || posting?.typeOfEmployment?.id || '';

  return {
    id: `villa-im-park-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: VILLA_IM_PARK_COMPANY_NAME,
    companyKey: VILLA_IM_PARK_KEY,
    companyDomain: VILLA_IM_PARK_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: city,
    canton,
    url: publicUrl,
    source: 'Privatklinik Villa im Park Dedicated Parser (SmartRecruiters)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: city,
    addressRegion: canton,
    streetAddress: street,
    addressCountry: 'CH',
    country: 'CH',
    postalCode,
    category: detectCategory(title),
    contract: detectEmploymentType(title, srType) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(title, srType),
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

export async function fetchAllVillaImParkJobs() {
  console.log(`🔍 Fetching Privatklinik Villa im Park jobs (SmartRecruiters)`);
  console.log(`   Career: ${CAREER_URL}`);
  console.log(`   API:    ${LIST_URL_BASE}  (filter: Brand == PKV)\n`);

  const all = [];
  let offset = 0;
  const limit = 100;
  let totalFound = Infinity;

  while (offset < totalFound && offset < 1000) {
    let data;
    try {
      data = await fetchJson(`${LIST_URL_BASE}?limit=${limit}&offset=${offset}`);
    } catch (err) {
      console.warn(`⚠️ SmartRecruiters list fetch failed (offset=${offset}): ${err?.message || err}`);
      break;
    }
    totalFound = Number(data?.totalFound) || 0;
    const content = assertJsonListShape(data, { key: 'content', source: 'villa-im-park' });
    if (content.length === 0) break;
    all.push(...content);
    offset += content.length;
    if (content.length < limit) break;
  }
  console.log(`   Fetched ${all.length} total SwissMedicalNetwork postings`);

  const pkvOnly = all.filter(isPKVBrand);
  console.log(`   PKV-branded postings: ${pkvOnly.length}`);

  const jobs = [];
  for (const posting of pkvOnly) {
    let detail;
    try {
      detail = await fetchJson(`${LIST_URL_BASE}/${posting.id}`);
    } catch (err) {
      console.warn(`⚠️ Detail fetch ${posting.id} failed: ${err?.message || err}`);
      detail = null;
    }
    try {
      const job = buildParsedJob(posting, detail);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`⚠️ Skipping ${posting.id}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total Privatklinik Villa im Park jobs discovered: ${jobs.length}`);
  return jobs;
}
