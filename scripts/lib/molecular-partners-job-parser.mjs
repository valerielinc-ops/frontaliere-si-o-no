#!/usr/bin/env node
/**
 * Molecular Partners job parser — Talentsoft (Cegid) ATS.
 *
 * Public career page: https://www.molecularpartners.com/careers/ (embeds a
 * Talentsoft iframe: `talentsoft-frame` → molecularpartners-career.talent-soft.com).
 * All-jobs listing:   /job/list-of-all-jobs.aspx?all=1&mode=list
 *
 * Same ATS family as aarReha Schinznach (scripts/lib/aarreha-schinznach-job-parser.mjs).
 * The list page renders each offer as a server-rendered
 * `<li class="ts-offer-list-item">` with a `data-reference="YYYY-NNN"` id and
 * a `<ul class="ts-offer-list-item__description">` carrying `Ref. : ...` and
 * the posted date (dd/mm/yyyy) — no location/department in the listing.
 * Detail page content lives under `id="contenu-ficheoffre"` and includes a
 * dedicated "Position location" section (`#fldlocation_location_geographicalareacollection`).
 *
 * Molecular Partners is a single-site biotech (DARPin therapeutics) based in
 * Zürich-Schlieren — all vacancies observed so far are at the Wagistrasse 14
 * HQ, so location/canton default to Schlieren/ZH unless the detail page
 * states otherwise.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MOLECULAR_PARTNERS_KEY = 'molecular-partners';
export const MOLECULAR_PARTNERS_COMPANY_NAME = 'Molecular Partners';
export const MOLECULAR_PARTNERS_COMPANY_DOMAIN = 'molecularpartners.com';

const PORTAL_BASE = 'https://molecularpartners-career.talent-soft.com';
const LISTING_URL = `${PORTAL_BASE}/job/list-of-all-jobs.aspx?all=1&mode=list`;
const DETAIL_DELAY_MS = 300;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Molecular Partners.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMolecularPartnersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MOLECULAR_PARTNERS_KEY ||
    key.startsWith('molecular-partners') ||
    company.includes('molecular partners') ||
    url.includes('molecularpartners.com') ||
    url.includes('molecularpartners-career.talent-soft.com')
  );
}

/**
 * Validate that a URL belongs to Molecular Partners's domain (public site or
 * the Talentsoft-hosted portal).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'molecularpartners.com' ||
      host.endsWith('.molecularpartners.com') ||
      host === 'molecularpartners-career.talent-soft.com'
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(process development|manufactur|cmc|upstream|downstream|gmp|production|technical operations|tech ops)/.test(t)) return 'Produzione';
  if (/\b(research|scientist|biolog|chemist|pharmacolog|preclinical|discovery)/.test(t)) return 'Ricerca';
  if (/\b(clinical|regulatory|pharmacovigilance|medical affairs|drug safety)/.test(t)) return 'Sanità';
  if (/\b(quality|qa|qc)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|data)/.test(t)) return 'IT';
  if (/\b(hr|human resources|talent|people)/.test(t)) return 'Risorse Umane';
  if (/\b(market|communicat|investor relations)/.test(t)) return 'Marketing';
  if (/\b(finance|accounting|controll)/.test(t)) return 'Finanza';
  if (/\b(legal|patent|intellectual property)/.test(t)) return 'Legale';
  if (/\b(admin|assistant|office)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|internship|trainee|apprentice|phd student)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|manager|vp|vice president|chief)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\bpart.?time\b/.test(t)) return 'PART_TIME';
  if (/\bfull.?time\b/.test(t)) return 'FULL_TIME';
  // Swiss job ads express workload as a percentage range, e.g. "80-100%".
  // Treat ranges whose upper bound is >= 90% as full-time (the "100%"
  // ceiling with lower-bound flexibility is the Swiss convention for a
  // full-time role open to slight reductions), else part-time.
  const rangeMatch = t.match(/\b(\d{1,3})\s*-\s*(\d{1,3})\s*%/);
  if (rangeMatch) {
    const upper = Number(rangeMatch[2]);
    return upper >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  const singleMatch = t.match(/\b(\d{1,3})\s*%/);
  if (singleMatch) {
    return Number(singleMatch[1]) >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Parse the Talentsoft listing into `{ detailUrl, title, ref, postedDate }`.
 * Format:
 *
 *   <li class="ts-offer-list-item ..." onclick="location.href='{REL_URL}';">
 *     <h3><a class="ts-offer-list-item__title-link" href="{REL_URL}">{TITLE}</a></h3>
 *     <span ... data-reference="{YYYY-NNN}" ...></span>
 *     <ul class="ts-offer-list-item__description">
 *       <li>Ref. : {YYYY-NNN}</li><li>{dd/mm/yyyy}</li>
 *     </ul>
 *   </li>
 */
export function parseMolecularPartnersListing(html) {
  const out = [];
  const seen = new Set();
  const itemRe = /<li class="ts-offer-list-item[^"]*"[^>]*onclick="location\.href='([^']+)';"[^>]*>([\s\S]*?)<\/ul>\s*<\/li>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const rel = m[1];
    const block = m[2];
    const detailUrl = rel.startsWith('http') ? rel : `${PORTAL_BASE}${rel}`;

    const titleMatch = block.match(/<a\s+class="ts-offer-list-item__title-link[^"]*"[\s\S]*?>([\s\S]*?)<\/a>/);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')))
      : '';
    if (!title || title.length < 3) continue;

    const refMatch = block.match(/data-reference="([0-9-]+)"/) || block.match(/Ref\.\s*:\s*([0-9-]+)/);
    const ref = refMatch ? refMatch[1] : '';

    const descLis = [];
    const ulMatch = block.match(/<ul class="ts-offer-list-item__description[^"]*">([\s\S]*)$/);
    if (ulMatch) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let lm;
      while ((lm = liRe.exec(ulMatch[1]))) {
        descLis.push(normalizeSpace(decodeEntities(lm[1].replace(/<[^>]+>/g, ''))));
      }
    }
    const dateEntry = descLis.find((d) => /^\d{2}\/\d{2}\/\d{4}$/.test(d));
    let postedDate = '';
    if (dateEntry) {
      const [dd, mm, yyyy] = dateEntry.split('/');
      postedDate = `${yyyy}-${mm}-${dd}`;
    }

    const key = ref || detailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ detailUrl, title, ref, postedDate });
  }
  return out;
}

async function fetchDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { description: '', location: '' };

    const startMatch = html.match(/id="contenu-ficheoffre"[^>]*>([\s\S]+)/);
    const block = startMatch ? startMatch[1].slice(0, 16000) : '';
    const cutMatch = block.match(/[\s\S]+?(?=<footer|<\/main)/);
    const trimmed = cutMatch ? cutMatch[0] : block;
    const description = normalizeSpace(stripHtml(trimmed)).slice(0, 6000);

    const locMatch = html.match(/id="fldlocation_location_geographicalareacollection"[^>]*>([\s\S]*?)<\/p>/);
    const location = locMatch
      ? normalizeSpace(decodeEntities(locMatch[1].replace(/<[^>]+>/g, '')))
      : '';

    return { description, location };
  } catch (err) {
    console.warn(`  ⚠️ Molecular Partners detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return { description: '', location: '' };
  }
}

/**
 * Fetch all Molecular Partners jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllMolecularPartnersJobs() {
  console.log(`🔍 Fetching ${MOLECULAR_PARTNERS_COMPANY_NAME} jobs (Talentsoft)`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Talentsoft paginates ~10 offers per page. Walk pages until an empty page
  // or no newly-seen refs. Cap at 20 pages for safety (mirrors aarReha).
  const MAX_PAGES = 20;
  const rows = [];
  const seenKeys = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}&page=${page}`;
    const html = await fetchHtml(url);
    const pageRows = parseMolecularPartnersListing(html);
    if (!pageRows.length) {
      console.warn(`  ⚠️ page ${page}: parsed 0 rows — treating as end of pagination.`);
      break;
    }
    let added = 0;
    for (const r of pageRows) {
      const key = r.ref || r.detailUrl;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      rows.push(r);
      added += 1;
    }
    console.log(`  · page ${page}: ${pageRows.length} parsed (+${added} new)`);
    if (added === 0) break;
  }
  console.log(`  ✓ ${rows.length} Talentsoft offers (deduped across pages)`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const { description: detailText, location: detailLocation } = await fetchDetail(r.detailUrl);

    const location = detailLocation || 'Zürich, Schlieren';
    const canton = inferSwissTargetCanton(location) || 'ZH';

    const summaryPieces = [
      r.ref ? `Referenza: ${r.ref}` : '',
      `Sede: ${location}`,
    ].filter(Boolean);
    const description = detailText && detailText.split(/\s+/).length >= 30
      ? detailText
      : [
        ...summaryPieces,
        `${MOLECULAR_PARTNERS_COMPANY_NAME} — clinical-stage biotech company developing DARPin therapeutics, headquartered in Zürich-Schlieren (Switzerland).`,
      ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'en');
    const jobSlug = slugify(`${r.title} molecular-partners schlieren`);
    const urlHash = createHash('sha1').update(r.detailUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${MOLECULAR_PARTNERS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MOLECULAR_PARTNERS_COMPANY_NAME,
      companyKey: MOLECULAR_PARTNERS_KEY,
      companyDomain: MOLECULAR_PARTNERS_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: r.detailUrl,
      source: `${MOLECULAR_PARTNERS_COMPANY_NAME} Dedicated Parser (Talentsoft)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Schlieren',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8952',
      category: detectCategory(r.title),
      contract: 'full-time',
      employmentType: detectEmploymentType(`${r.title} ${description}`),
      experienceLevel: detectExperienceLevel(r.title),
      sector: 'Biotecnologie / Farmaceutica',
      currency: 'CHF',
      featured: false,
      postedDate: r.postedDate || todayIso,
      applyUrl: r.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${MOLECULAR_PARTNERS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
