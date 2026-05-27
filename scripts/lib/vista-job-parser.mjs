#!/usr/bin/env node
/**
 * Vista Augenpraxen & Kliniken job parser — Ostendis JobPublisher API.
 *
 * Public career site: https://vista.ch/ueber-uns/karriere/
 *
 * Vista is a national network of ophthalmology practices and clinics,
 * headquartered in Binningen (BL). The career page embeds the Ostendis
 * JobPublisher widget, which fetches structured listings from:
 *
 *   GET https://odm.ostendis.com/ojp/data/v54/jobs/{token}/DE?domain=vista.ch
 *
 * Each Ostendis job entry carries `city` and `zip`, so we resolve the canton
 * per job via `inferAnyCanton()` instead of falling back to the company HQ.
 * Vista vacancies span ZH (Zürich), BL (Binningen, Liestal), AG (Brugg,
 * Dättwil), BS (Basel), BE (Burgdorf), etc.
 *
 * Detail pages are at `link.ostendis.com/publication/{slug}/{hash}` and
 * carry a JSON-LD `JobPosting` block — the same enrichment pattern used by
 * RSS Surselva.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

export const VISTA_KEY = 'vista';
export const VISTA_COMPANY_NAME = 'Vista Augenpraxen & Kliniken';
export const VISTA_COMPANY_DOMAIN = 'vista.ch';

const CAREER_URL = 'https://vista.ch/ueber-uns/karriere/';
const OSTENDIS_API_BASE = 'https://odm.ostendis.com/ojp/data/v54/jobs';
const OSTENDIS_TOKEN = '748a5e05dbc2494dacd27e76040385cc';
const OSTENDIS_LANG = 'DE';
const OSTENDIS_DOMAIN = 'vista.ch';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * link.ostendis.com (detail-page CDN) is fronted by mod_security and returns
 * HTTP 406 to the default bot UA. The Ostendis API itself accepts the bot UA
 * but detail-page hydration needs a stock browser fingerprint.
 */
const BROWSER_USER_AGENT = process.env.JOBS_CRAWLER_BROWSER_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

const COMPANY_BOILERPLATE = "Vista Augenpraxen & Kliniken ist eine schweizweit tätige Gruppe für Augenheilkunde mit Standorten in den Kantonen Zürich, Basel-Stadt, Basel-Landschaft, Aargau, Bern und weiteren. Wir bieten ein interdisziplinäres Team, moderne Infrastruktur und attraktive Anstellungsbedingungen für Fachpersonen in Augenoptik, Pflege, MTRA/MPA, Ophthalmologie und Verwaltung.";

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isVistaJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === VISTA_KEY) return true;
  if (/\bvista\b/.test(company) && /(augen|ophtalm|ophthalm)/.test(company)) return true;
  if (url.includes('vista.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'vista.ch' || host.endsWith('.vista.ch')) return true;
    if (host === 'link.ostendis.com') return true;
    if (host === 'odm.ostendis.com') return true;
    if (host.endsWith('.ostendis.com')) return true;
    return false;
  } catch {
    return false;
  }
}

function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const combined = `${t} ${d}`;
  if (/\b(arztsekret|sekretär|admin|verwaltung|controlling|buchhalt|empfang|rezept)/.test(combined)) return 'Amministrazione';
  if (/\b(augenoptiker|optiker|optician)/.test(combined)) return 'Sanità';
  if (/\b(arzt|ärztin|ober[aä]rzt|medizin|ophthalm|ophtalm|chirurg)/.test(combined)) return 'Medicina';
  if (/\b(pflege|fachperson gesundheit|fage|betreu|hebamme)/.test(combined)) return 'Infermieristica';
  if (/\b(orthoptist)/.test(combined)) return 'Sanità';
  if (/\b(praxisassist|mpa|mfa)/.test(combined)) return 'Sanità';
  if (/\b(operationstech|toa|technik|techniker)/.test(combined)) return 'Tecnica';
  if (/\b(labor|biomedizin|mtla|radiolog|röntgen|mtra)/.test(combined)) return 'Laboratorio';
  if (/\b(it|software|informatik)/.test(combined)) return 'IT';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|co-leit|oberarzt|oberärztin|facharzt|fachärztin)/.test(t)) return 'senior';
  return 'mid';
}

function inferEmploymentType(title = '') {
  const t = normalize(title);
  const rangeMatch = t.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (rangeMatch) {
    const max = parseInt(rangeMatch[2], 10);
    return max >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  const singleMatch = t.match(/(\d+)\s*%/);
  if (singleMatch) {
    const pct = parseInt(singleMatch[1], 10);
    return pct >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'FULL_TIME';
}

async function fetchOstendisListings() {
  const url = `${OSTENDIS_API_BASE}/${OSTENDIS_TOKEN}/${OSTENDIS_LANG}?domain=${OSTENDIS_DOMAIN}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Ostendis API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchDetailPage(detailUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(detailUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': BROWSER_USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from detail page: ${detailUrl}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export function parseDetailPageJsonLd(html = '') {
  const result = {
    description: '',
    datePosted: '',
    employmentType: '',
    streetAddress: '',
    addressLocality: '',
    postalCode: '',
    addressRegion: '',
  };
  const jsonLdMatch = String(html).match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!jsonLdMatch) return result;
  try {
    const data = JSON.parse(jsonLdMatch[1]);
    if (data['@type'] !== 'JobPosting') return result;
    if (data.description) {
      result.description = normalizeSpace(stripHtml(data.description));
    }
    if (data.datePosted) result.datePosted = data.datePosted;
    if (data.employmentType) {
      const types = Array.isArray(data.employmentType) ? data.employmentType : [data.employmentType];
      if (types.includes('FULL_TIME')) result.employmentType = 'FULL_TIME';
      else if (types.includes('PART_TIME')) result.employmentType = 'PART_TIME';
    }
    const address = data.jobLocation?.address;
    if (address) {
      result.streetAddress = address.streetAddress || '';
      result.addressLocality = address.addressLocality || '';
      result.postalCode = address.postalCode || '';
      result.addressRegion = address.addressRegion || '';
    }
  } catch {
    /* swallow JSON-LD parse failures */
  }
  return result;
}

export function parseVistaOstendisJob(entry, detailData = {}) {
  const title = normalizeSpace(entry?.title || '');
  if (!title || title.length < 3) return null;

  const location = normalizeSpace(entry.city || detailData.addressLocality || 'Binningen');
  const canton = inferAnyCanton(location) || detailData.addressRegion || 'BL';
  const postalCode = entry.zip || detailData.postalCode || '4102';
  const streetAddress = detailData.streetAddress || 'Hauptstrasse 55';

  const publicUrl = entry.detail || CAREER_URL;
  const applyUrl = entry.action || publicUrl;
  const idSource = entry.id ? String(entry.id) : publicUrl;
  const urlHash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);

  let descriptionText = detailData.description || '';
  if (!descriptionText || descriptionText.length < 150) {
    const parts = [`${title} bei ${VISTA_COMPANY_NAME}`];
    if (entry.department) parts.push(`Abteilung: ${entry.department}`);
    parts.push(`Arbeitsort: ${location} (${postalCode}, ${canton})`);
    parts.push(COMPANY_BOILERPLATE);
    descriptionText = parts.join('. ');
  }

  const employmentType = detailData.employmentType || inferEmploymentType(title);
  const rangeMatch = normalize(title).match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  const singleMatch = normalize(title).match(/(\d+)\s*%/);
  let pensumMin;
  let pensumMax;
  let pensum;
  if (rangeMatch) {
    pensumMin = parseInt(rangeMatch[1], 10);
    pensumMax = parseInt(rangeMatch[2], 10);
    pensum = pensumMin === pensumMax ? `${pensumMin}%` : `${pensumMin} - ${pensumMax}%`;
  } else if (singleMatch) {
    pensumMin = parseInt(singleMatch[1], 10);
    pensumMax = pensumMin;
    pensum = `${pensumMin}%`;
  }
  const contract = (pensumMax && pensumMax < 90) ? 'part-time' : 'full-time';
  const sourceLang = detectLang(descriptionText || title, 'de');
  const jobSlug = slugify(`${title} ${VISTA_KEY} ${location}`);
  const datePosted = detailData.datePosted || new Date().toISOString().slice(0, 10);

  return {
    id: `${VISTA_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: VISTA_COMPANY_NAME,
    companyKey: VISTA_KEY,
    companyDomain: VISTA_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText,
    descriptionByLocale: { [sourceLang]: descriptionText },
    // Newly-discovered jobs ship with source-locale-only fields. The shared
    // AI-localization step clears this flag when it fills the remaining 3
    // locales; if it can't (cache miss + AI quota), the flag stays and
    // `translate-pending.yml` picks the job up out-of-band. Without this
    // flag the locale-completeness gate trips before translation can run.
    needsRetranslation: true,
    location,
    canton,
    url: publicUrl,
    source: `${VISTA_COMPANY_NAME} Dedicated Parser (Ostendis JobPublisher)`,
    sourceLang,
    crawledAt: new Date().toISOString(),

    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    country: 'CH',
    postalCode,
    streetAddress,
    category: detectCategory(title, entry.department || ''),
    contract,
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Sanità / Ospedali',
    currency: 'CHF',
    featured: false,
    postedDate: datePosted,
    applyUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    ...(entry.department ? { department: entry.department } : {}),
    ...(pensum ? { pensum, pensumMin, pensumMax } : {}),
  };
}

export async function fetchAllVistaJobs() {
  console.log(`🏥 Fetching ${VISTA_COMPANY_NAME} jobs`);
  console.log(`   Source: Ostendis JobPublisher API (token ${OSTENDIS_TOKEN.slice(0, 8)}…)\n`);

  const data = await fetchOstendisListings();
  const listings = data?.jobs;
  if (!listings || !Array.isArray(listings) || listings.length === 0) {
    console.warn('⚠️ No job listings returned from Ostendis API.');
    return [];
  }
  console.log(`  📋 Ostendis listings found: ${listings.length}`);

  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;
  for (const entry of listings) {
    const title = normalizeSpace(entry?.title || '');
    if (!title || title.length < 3) continue;

    let detailData = {};
    if (entry.detail) {
      try {
        const detailHtml = await fetchDetailPage(entry.detail);
        detailData = parseDetailPageJsonLd(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err?.message || err}`);
      }
    }

    const job = parseVistaOstendisJob(entry, detailData);
    if (!job) continue;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${job.location} (${job.canton}, ${job.employmentType})`);
  }

  console.log(`\n📋 Total ${VISTA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export {
  CAREER_URL,
  OSTENDIS_API_BASE,
  OSTENDIS_TOKEN,
  OSTENDIS_DOMAIN,
};
