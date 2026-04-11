#!/usr/bin/env node
/**
 * Fachhochschule Graubünden (FHGR) job parser — Umantis ATS (tenant 2865).
 *
 * Listing page: https://jobs.fhgr.ch/Jobs/All?lang=ger
 *   - Server-rendered HTML table with alternating row classes
 *   - Job rows: <tr class="tableaslist_contentrow1|2">
 *   - Title+link: <span class="tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/1">
 *   - Art:        <span class="tableaslist_element_1152491"> (e.g. "Art: Vollzeit")
 *   - Befristung: <span class="tableaslist_element_1152492"> (e.g. "Befristung: Unbefristet")
 *   - Entry lvl:  <span class="tableaslist_element_1152493"> (e.g. "Einstieg als: Dozent/in, Kader")
 *   - Location:   <span class="tableaslist_element_1152495"> (e.g. "Chur")
 *   - Department: <span class="tableaslist_element_1152496"> (e.g. "Abteilung/Institut: SIFE")
 *   - Snippet:    <span class="tableaslist_element_1152498"> (short teaser text)
 *
 * Detail page: /Vacancies/{ID}/Description/1
 *   - <title>Job Title</title>
 *   - <div class="puptitel1"> → <h1><b>Title</b></h1>
 *   - <div class="einleitung" id="einschub"> = intro paragraph
 *   - <div class="text" id="einschub"> = content blocks (tasks, profile, benefits)
 *   - <div class="bewerbung"> → apply link
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFhgrJobs()    — Fetch and parse all jobs
 *   - isFhgrJob()           — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FHGR_KEY = 'fhgr';
export const FHGR_COMPANY_NAME = 'Fachhochschule Graubünden';
export const FHGR_COMPANY_DOMAIN = 'fhgr.ch';

const BASE_URL = 'https://jobs.fhgr.ch';
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Decode HTML entities (&amp; &nbsp; &uuml; etc.) from Umantis HTML.
 */
function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#8209;/g, '-')
    .replace(/&#x2011;/g, '-')
    .replace(/&ndash;/g, '–')
    .replace(/&#8211;/g, '–')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to FHGR.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFhgrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FHGR_KEY ||
    key.startsWith('fhgr') ||
    company.includes('fachhochschule graubünden') ||
    company.includes('fachhochschule graubunden') ||
    company.includes('fh graubünden') ||
    company.includes('fh graubunden') ||
    url.includes('fhgr.ch') ||
    url.includes('jobs.fhgr.ch')
  );
}

/**
 * Validate that a URL belongs to FHGR's domain or the Umantis ATS.
 * Trusts both fhgr.ch and umantis.com.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'fhgr.ch' ||
      host.endsWith('.fhgr.ch') ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from title and department fields.
 * FHGR is a university of applied sciences — most roles are education/research related.
 */
function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(dozent|professor|studienleiter|studiengang|lehre|lehr|didaktik|education|teaching)/.test(signal)) return 'Formazione / Ricerca';
  if (/\b(forsch|research|wissenschaft|projekt|labor|laborant)/.test(signal)) return 'Formazione / Ricerca';
  if (/\b(institut|akadem|dekan|rektor|studien)/.test(signal)) return 'Formazione / Ricerca';
  if (/\b(it|software|develop|programm|devops|system|architect|cyber|security|cloud|daten|data|informatik|digital)/.test(signal)) return 'IT';
  if (/\b(ingenieur|engineer|bauingenieur|architekt|bauen|tiefbau|hochbau)/.test(signal)) return 'Ingegneria';
  if (/\b(techni|instandhalt|facility|wartung|maintenance|install|elektr|sanitär|hlks|photovoltaik)/.test(signal)) return 'Tecnica';
  if (/\b(market|kommunik|comunicaz|brand|digital|online|pr\b|social.?media)/.test(signal)) return 'Marketing';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(admin|segret|contab|buchhalt|account|controlling|finanzbuchhalt|sachbearbeiter)/.test(signal)) return 'Amministrazione';
  if (/\b(compliance|risk|audit|revision|recht|legal|jurist)/.test(signal)) return 'Legale';
  if (/\b(bibliothek|library|medien|information)/.test(signal)) return 'Formazione / Ricerca';
  if (/\b(lernend|praktik|trainee|ausbildung|apprenti|lehrstelle)/.test(signal)) return 'Formazione';
  if (/\b(logist|magazz|lager|einkauf)/.test(signal)) return 'Logistica';
  return 'Formazione / Ricerca';
}

function detectExperienceLevel(title = '', entryLevel = '') {
  const t = normalize(title);
  const e = normalize(entryLevel);
  const signal = `${t} ${e}`;
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|lehrstelle)/.test(signal)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(signal)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|institutsleiter|studienleiter|professor|kader)/.test(signal)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from the "Art" field and title.
 * Examples: "Vollzeit", "Teilzeit"
 */
function detectEmploymentType(artText = '', title = '') {
  const t = normalize(artText || title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  // Check percentage in title
  const pctMatch = normalize(title).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalize(title).match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/**
 * Extract pensum percentage from the title string.
 * Examples: "80-100%", "60 - 100 %", "40%", "100 %"
 */
function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse the Umantis listing page HTML and return an array of listing objects.
 * Each object: { vacancyId, title, location, department, artText, befristung, entryLevel, snippet, detailUrl, applyUrl }
 *
 * Tenant 2865 element IDs:
 *   - 1152488: title + link
 *   - 1152491: Art (Vollzeit/Teilzeit)
 *   - 1152492: Befristung (Unbefristet/Befristet)
 *   - 1152493: Einstieg als (entry level)
 *   - 1152495: Location (e.g. "Chur")
 *   - 1152496: Abteilung/Institut (department)
 *   - 1152498: Snippet (teaser text)
 */
export function parseFhgrListingPage(html = '') {
  const results = [];
  const seen = new Set();

  // Match alternating row classes
  const rowRegex = /<tr\s+class="tableaslist_contentrow[12]">([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Extract title + link from element 1152488
    const titleMatch = rowHtml.match(
      /tableaslist_element_1152488[\s\S]*?<a\s+href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/
    );
    if (!titleMatch) continue;

    const vacancyId = titleMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(decodeEntities(titleMatch[2]));
    if (!title || title.length < 3) continue;

    // Skip initiative/spontaneous application placeholders
    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title.trim())) continue;

    // Extract other fields using element class IDs
    const artRaw = extractSpanText(rowHtml, '1152491');
    const befristungRaw = extractSpanText(rowHtml, '1152492');
    const entryLevelRaw = extractSpanText(rowHtml, '1152493');
    const locationRaw = extractSpanText(rowHtml, '1152495');
    const departmentRaw = extractSpanText(rowHtml, '1152496');
    const snippetRaw = extractSpanText(rowHtml, '1152498');

    // Clean the prefix labels
    const artText = normalizeSpace(artRaw.replace(/^\|?\s*Art:\s*/i, ''));
    const befristung = normalizeSpace(befristungRaw.replace(/^\|?\s*Befristung:\s*/i, ''));
    const entryLevel = normalizeSpace(entryLevelRaw.replace(/^\|?\s*Einstieg als:\s*/i, ''));
    const location = extractLocation(locationRaw);
    const department = normalizeSpace(departmentRaw.replace(/^\|?\s*Abteilung\/Institut:\s*/i, ''));
    const snippet = normalizeSpace(snippetRaw);

    results.push({
      vacancyId,
      title,
      location,
      department,
      artText,
      befristung,
      entryLevel,
      snippet,
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    });
  }

  return results;
}

/**
 * Extract text from a span with a specific Umantis element class.
 */
function extractSpanText(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[^>]*>([\\s\\S]*?)(?=<span class="tableaslist_|<br\\s*/?>|$)`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

/**
 * Extract location city from the Umantis location field.
 * FHGR locations are typically just "Chur" (most jobs are in Chur).
 */
export function extractLocation(rawLocation = '') {
  const loc = normalizeSpace(decodeEntities(rawLocation))
    .replace(/^\|?\s*/, '')
    .trim();

  if (!loc) return 'Chur';

  // Remove common prefixes
  const cleaned = loc
    .replace(/^(hauptsitz|region|standort|campus)\s+/i, '')
    .trim();

  return cleaned || 'Chur';
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Parse an FHGR detail page and extract the full job description.
 *
 * The detail page uses a custom template:
 *   - <div class="puptitel1"> → <h1><b>Title</b></h1>
 *   - <div class="einleitung" id="einschub"> = intro paragraph
 *   - <div class="text" id="einschub"> = content blocks (tasks, profile, benefits)
 *   - <div class="kontakt"> = contact info
 *   - <div class="bewerbung"> = apply section
 */
export function parseFhgrDetailPage(html = '', fallbackTitle = '') {
  // Extract title from <h1> inside puptitel1
  const h1Match = html.match(/<h1[^>]*>(?:<b>)?([^<]+)(?:<\/b>)?<\/h1>/);
  const titleTagMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = normalizeSpace(decodeEntities(
    h1Match ? h1Match[1] : (titleTagMatch ? titleTagMatch[1] : fallbackTitle)
  ));

  // Extract all meaningful content blocks
  const blocks = [];

  // Intro text from <div class="einleitung" id="einschub">
  const introMatch = html.match(/<div\s+class="einleitung"[^>]*>([\s\S]*?)<\/div>/);
  if (introMatch) {
    const introText = normalizeSpace(stripHtml(decodeEntities(introMatch[1])));
    if (introText.length > 20) blocks.push(introText);
  }

  // Content from <div class="text" id="einschub"> (multiple occurrences)
  const textRegex = /<div\s+class="text"\s+id="einschub"[^>]*>([\s\S]*?)<\/div>/g;
  let textMatch;

  while ((textMatch = textRegex.exec(html)) !== null) {
    const rawContent = textMatch[1];
    const cleaned = normalizeSpace(stripHtml(decodeEntities(rawContent)));
    if (cleaned.length > 20) {
      blocks.push(cleaned);
    }
  }

  // Join all meaningful content blocks
  const description = blocks.join(' | ');

  return { title, description };
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all FHGR jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML → parse rows
 *   2. For each job, fetch detail page → extract description
 *   3. Build ParsedJob objects
 */
export async function fetchAllFhgrJobs() {
  console.log(`🎓 Fetching Fachhochschule Graubünden jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch and parse listing page
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseFhgrListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}\n`);

  // Step 2: Fetch detail pages and build jobs
  const jobs = [];
  for (const listing of listings) {
    let descriptionText = '';
    let detailTitle = listing.title;

    try {
      const detailHtml = await fetchPage(listing.detailUrl);
      const detail = parseFhgrDetailPage(detailHtml, listing.title);
      descriptionText = detail.description;
      if (detail.title) detailTitle = detail.title;
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for ${listing.vacancyId}: ${err?.message}`);
      // Use snippet from listing as fallback description
      if (listing.snippet) {
        descriptionText = listing.snippet;
      }
    }

    const title = detailTitle;
    const location = listing.location || 'Chur';
    const canton = inferSwissTargetCanton(location) || 'GR';

    const fallbackDesc = `${title} — Fachhochschule Graubünden, ${location}`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} fhgr ch`);
    const urlHash = createHash('sha1')
      .update(`fhgr-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `fhgr-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FHGR_COMPANY_NAME,
      companyKey: FHGR_KEY,
      companyDomain: FHGR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton,
      url: listing.detailUrl,
      source: 'Fachhochschule Graubünden Dedicated Parser (Umantis)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '7000',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, listing.entryLevel),
      sector: 'Formazione / Ricerca',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (listing.department) {
      job.department = listing.department;
    }
    if (listing.befristung) {
      job.contractDuration = listing.befristung.toLowerCase() === 'befristet' ? 'temporary' : 'permanent';
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} — ${location} (${listing.department || 'N/A'})`);

    // Rate limiting between detail page fetches
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n📋 Total FHGR jobs discovered: ${jobs.length}`);
  return jobs;
}
