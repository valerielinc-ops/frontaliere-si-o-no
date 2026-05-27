#!/usr/bin/env node
/**
 * Caritas Schweiz job parser — Refline ATS tenant 126757.
 *
 * Public career site:
 *   https://www.caritas.ch/de/karriere/
 *     → embeds iframe: https://apply.refline.ch/126757/positions_grouped.html
 *
 * The grouped Refline listing exposes a single HTML page split into
 * <div class="searchBox"> sections — one per Caritas sub-organisation
 * (Inland, Schweiz Ausland, Zürich, Aargau, ...). Each table row carries:
 *   - <a href=".../{posId}/pub/{rev}/index.html">Title</a>
 *   - <td class="workplace">{LOCATION}</td>
 *   - <td class="workload">{PENSUM}</td>
 *
 * Caritas Schweiz is the national catholic NGO operating social-work,
 * migration, anti-poverty and care programmes across all 26 cantons,
 * with HQ in Luzern. Approximately 1'500 employees nationwide; the
 * Refline listing is shared by every regional Caritas (the section title
 * encodes which one).
 *
 * Exports the 4 required functions for the crawler template.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CARITAS_SCHWEIZ_KEY = 'caritas-schweiz';
export const CARITAS_SCHWEIZ_COMPANY_NAME = 'Caritas Schweiz';
export const CARITAS_SCHWEIZ_COMPANY_DOMAIN = 'caritas.ch';

const REFLINE_TENANT = '126757';
const REFLINE_LISTING_URL = `https://apply.refline.ch/${REFLINE_TENANT}/positions_grouped.html`;
const PUBLIC_CAREER_URL = 'https://www.caritas.ch/de/karriere/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DEFAULT_CITY = 'Luzern';
const DEFAULT_POSTAL = '6002';
const DEFAULT_CANTON = 'LU';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isCaritasSchweizJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CARITAS_SCHWEIZ_KEY ||
    key.startsWith('caritas-schweiz') ||
    company.includes('caritas schweiz') ||
    (company.includes('caritas') && !company.includes('caritas-ti') && !company.includes('caritas ticino')) ||
    url.includes('caritas.ch') ||
    url.includes(`apply.refline.ch/${REFLINE_TENANT}`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'caritas.ch' || host.endsWith('.caritas.ch')) return true;
    if ((host === 'apply.refline.ch' || host === 'pub.refline.ch') && rawUrl.includes(`/${REFLINE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Detection helpers ─────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|fage|spitex|nachtwache)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(sozial|sozialarbeit|sozialpädag|sozialberat|sozialhilfe|sozialp[aä]d|psycho|berater|beratung)/.test(t)) return 'Sociale / Educazione';
  if (/\b(arzt|ärztin|medizin|gesundheit)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|youngcaritas)/.test(t)) return 'Formazione';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(laden|markt|verkauf|kasse|shop)/.test(t)) return 'Vendite';
  if (/\b(it|software|develop|programm|system|informatik|data)/.test(t)) return 'IT';
  if (/\b(market|kommunik|fundrais|partner|sponsor)/.test(t)) return 'Marketing';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung)/.test(t)) return 'Ospitalità';
  if (/\b(berufsbildung|ausbildung|formation|education|école|lehrer)/.test(t)) return 'Formazione';
  return 'Sociale / Educazione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|trainee|youngcaritas)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|teamleit|ladenleit|fachbereich|geschäftsführ)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(workload = '', title = '') {
  const source = `${workload} ${title}`.toLowerCase();
  if (/teilzeit|part[- ]?time/.test(source)) return 'PART_TIME';
  const range = source.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
  if (range) {
    const maxPct = parseInt(range[2], 10);
    if (maxPct < 80) return 'PART_TIME';
    return 'FULL_TIME';
  }
  const single = source.match(/(\d{1,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    if (v < 80) return 'PART_TIME';
    return 'FULL_TIME';
  }
  if (/vollzeit|full[- ]?time|100\s*%/.test(source)) return 'FULL_TIME';
  return 'OTHER';
}

function extractPensum(workload = '') {
  const range = workload.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = workload.match(/(\d{2,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return null;
}

/**
 * Map Caritas workplace string → (canton, postal) hint.
 * The workplace field is human-prose (e.g. "Kanton Zürich", "Fribourg",
 * "Aarau", "Zentralschweiz", "Kosovo"). We map known Swiss labels to
 * cantons; unknown → defaults (Luzern HQ).
 */
function pickLocationHints(workplace = '') {
  const wp = String(workplace || '').trim();
  if (!wp) return { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postal: DEFAULT_POSTAL };

  // Strip "Kanton" prefix
  const cleaned = wp.replace(/^Kanton\s+/i, '').trim();
  const inferred = inferSwissTargetCanton(cleaned);
  if (inferred) {
    return { city: cleaned, canton: inferred, postal: '' };
  }

  // Multi-region or foreign — keep workplace as label but anchor to HQ Luzern
  return { city: cleaned || DEFAULT_CITY, canton: DEFAULT_CANTON, postal: '' };
}

/* ── HTTP fetch ────────────────────────────────────────────── */

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,fr;q=0.7,it;q=0.5,en;q=0.3',
        Referer: PUBLIC_CAREER_URL,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

/**
 * Parse Refline positions_grouped.html for Caritas.
 *
 * Splits into <div class="searchBox"> sections, each with a title
 * (sub-organisation label) and a table of vacancies. Returns:
 *   [{ section, url, posId, rev, title, workplace, workload }, ...]
 */
export function parseCaritasReflineListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  // Match each searchBox with its title + body
  const boxRe = /<div class="searchBox">\s*<div class="title">([\s\S]*?)<\/div>([\s\S]*?)(?=<div class="searchBox">|<\/div>\s*<script|<\/form>|<\/body>)/gi;
  let boxMatch;
  while ((boxMatch = boxRe.exec(html)) !== null) {
    const section = normalizeSpace(stripHtml(boxMatch[1]));
    const boxBody = boxMatch[2];

    const rowRe = new RegExp(
      `<tr[^>]*>\\s*<td class="position">\\s*<a\\s+href="(https://apply\\.refline\\.ch/${REFLINE_TENANT}/(\\d+)/pub/(\\d+)/index\\.html)"[^>]*>([\\s\\S]*?)</a>\\s*</td>\\s*<td class="workplace">([\\s\\S]*?)</td>\\s*<td class="workload">([\\s\\S]*?)</td>`,
      'gi',
    );
    let m;
    while ((m = rowRe.exec(boxBody)) !== null) {
      const url = m[1];
      const posId = m[2];
      const rev = m[3];
      const title = normalizeSpace(stripHtml(m[4]));
      const workplace = normalizeSpace(stripHtml(m[5]));
      const workload = normalizeSpace(stripHtml(m[6]));
      if (!title || title.length < 3) continue;
      if (seen.has(posId)) continue;
      seen.add(posId);
      out.push({ section, url, posId, rev, title, workplace, workload });
    }
  }
  return out;
}

/* ── Detail parser ─────────────────────────────────────────── */

export function parseReflineDetail(html = '') {
  if (!html) return { title: '', description: '' };

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  const parts = [];
  const blockRe = /<(p|li|h3|h4)[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(cleaned)) !== null) {
    const tag = bm[1].toLowerCase();
    const text = normalizeDescriptionSpace(stripHtml(bm[2]));
    if (text.length > 20 && !/cookie|datenschutz|privacy|impressum|bewerbung absenden/i.test(text)) {
      parts.push(tag === 'li' ? `• ${text}` : text);
    }
  }
  return { title, description: parts.join('\n') };
}

/* ── Fallback description ──────────────────────────────────── */

function buildFallbackDescription(title, section, workplace) {
  const sectionLabel = section ? ` (${section})` : '';
  return [
    `${title} bei Caritas Schweiz${sectionLabel}${workplace ? ` in ${workplace}` : ''}.`,
    '',
    'Caritas Schweiz ist die nationale Hilfsorganisation der katholischen Kirche und engagiert sich seit über 120 Jahren in der Schweiz und weltweit für Menschen in Not.',
    '',
    'Was Caritas bietet:',
    '• Sinnstiftende Tätigkeit für eine soziale Schweiz',
    '• Engagierte und kompetente Kolleginnen und Kollegen',
    '• Vielfältige Aus- und Weiterbildungsmöglichkeiten',
    '• Faire und sozial verträgliche Anstellungsbedingungen',
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllCaritasSchweizJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🤝 Fetching ${CARITAS_SCHWEIZ_COMPANY_NAME} jobs`);
  console.log(`   Source: ${REFLINE_LISTING_URL} (Refline tenant ${REFLINE_TENANT})\n`);

  let listingHtml;
  try {
    listingHtml = await fetchPage(REFLINE_LISTING_URL, timeoutMs);
  } catch (err) {
    throw new Error(`Failed to fetch Refline listing: ${err?.message || err}`);
  }

  const listings = parseCaritasReflineListing(listingHtml);
  console.log(`  📋 Found ${listings.length} positions across ${new Set(listings.map((l) => l.section)).size} Caritas units\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on Refline page.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    let detail = { title: '', description: '' };
    try {
      const detailHtml = await fetchPage(listing.url, timeoutMs);
      detail = parseReflineDetail(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    const title = detail.title || listing.title;
    const hints = pickLocationHints(listing.workplace);
    const location = hints.city;
    const canton = hints.canton;
    const postalCode = hints.postal || DEFAULT_POSTAL;

    let description = '';
    if (detail.description && detail.description.split(/\s+/).length >= 50) {
      description = detail.description;
    } else {
      description = buildFallbackDescription(title, listing.section, listing.workplace);
    }

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${CARITAS_SCHWEIZ_KEY} ${location}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.workload, title);
    const pensum = extractPensum(listing.workload);

    const job = {
      id: `${CARITAS_SCHWEIZ_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CARITAS_SCHWEIZ_COMPANY_NAME,
      companyKey: CARITAS_SCHWEIZ_KEY,
      companyDomain: CARITAS_SCHWEIZ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: listing.url,
      source: `Caritas Schweiz Dedicated Parser (Refline ${REFLINE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sociale / NGO',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ [${listing.section}] ${title.substring(0, 60)} → ${location} (${listing.posId})`);

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total ${CARITAS_SCHWEIZ_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
