#!/usr/bin/env node
/**
 * Planzer Transport AG job parser — Solique ATS (tenant "planzer").
 *
 * Planzer is a Swiss family-owned transport/logistics group (est. 1936),
 * HQ at Lerzenstrasse 14, 8953 Dietikon (canton Zürich). The issue-tracker
 * row labelled this "Custom", but that label is unreliable in this
 * backlog — dormakaba, Rieter, Veeam and Lindt & Sprüngli were all
 * mislabeled "Custom" too when the real ATS was hidden behind a plain
 * WordPress career page. Same story here:
 *
 *   - https://www.planzer.ch/en/jobs-2/careers/ ships a WordPress
 *     "Recruitee" plugin (`recruitee-public.js`) that is a DEAD leftover —
 *     the enqueued script returns HTTP 200 with a genuinely empty body
 *     (confirmed across UA/compression variants), and the `/wp-json/wp/v2/job`
 *     REST route reports `x-wp-total: 0`. Neither is the real source.
 *   - The real board is embedded via iframe on the German career page
 *     (https://www.planzer.ch/de/jobs/):
 *       <div id="pl_solique_jobs">
 *         <iframe id="jobboard" src="https://live.solique.ch/planzer/" ...>
 *   - https://live.solique.ch/planzer/ is a **Solique** tenant (the same
 *     Swiss careers-portal SaaS already integrated for several healthcare
 *     tenants via scripts/lib/solique-common.mjs).
 *
 * Why this is a BESPOKE parser and not solique-common.mjs's createSoliqueParser:
 *   - solique-common.mjs hardcodes healthcare sector/category/employmentType/
 *     experienceLevel detection (hospital/clinic vocabulary) — wrong domain
 *     for a transport/logistics group.
 *   - Its listing-tile regex expects the shared templates' markup; Planzer's
 *     tiles use a *different* tenant markup: `<a id="{id}" href="/planzer/job/
 *     details/{id}">` (bare numeric id, tenant-prefixed relative href) wrapping
 *     flat single-value `.workload` divs (e.g. "80-100%"), not the min/max-span
 *     pair the shared parser expects.
 *   - The detail-page template is an entirely different "flip card" layout
 *     (`.tasks-wrapper/.tasks-back`, `.profile-wrapper/.profile-back`,
 *     `.benefits-container/.benefit-wrapper/.benefit-back`,
 *     `.company-portrait-wrapper`) not covered by any of the shared parser's
 *     known detail templates.
 *   - Only the truly generic low-level helpers are reused here: fetchHtml
 *     (crawler-template.mjs), decodeEntities (hospital-custom-html-helpers.mjs),
 *     slugify (crawler-template.mjs), detectLang (dedicated-crawler-common.mjs),
 *     inferSwissTargetCanton (target-swiss-locations.mjs).
 *
 * PII note: each Solique detail page carries a `.contact-wrapper` block with
 * a named HR contact + direct phone number (e.g. "Diana Schmutz / Personal-
 * abteilung / +41 62 387 96 30"). This parser NEVER reads `.contact` /
 * `.contact-wrapper` — only `.intro`, `.tasks-back`, `.profile-back`,
 * `.benefit-back` and `.company-portrait` are extracted.
 *
 * Group brands: the tenant lists postings for several Planzer-group
 * subsidiaries (Schönholzer, Marti, Röösli, "Tz", "Planzer Paket") under one
 * board — all surfaced here under the single `Planzer` company/companyKey so
 * the site's per-company grouping stays coherent; the specific subsidiary
 * brand (when present) is folded into the description, never dropped.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, fetchHtml, normalizeSpace as templateNormalizeSpace } from './crawler-template.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PLANZER_KEY = 'planzer';
export const PLANZER_COMPANY_NAME = 'Planzer';
export const PLANZER_COMPANY_DOMAIN = 'planzer.ch';

const TENANT = 'planzer';
const LISTING_URL = `https://live.solique.ch/${TENANT}/`;
const PORTAL_BASE = 'https://live.solique.ch';
const DETAIL_DELAY_MS = 300;
const MAX_DETAIL_CHARS = 6000;

function normalizeSpace(s = '') {
  return templateNormalizeSpace(String(s ?? ''));
}

/* ── HQ fallback (Lerzenstrasse 14, 8953 Dietikon, ZH) ────────
 * Verified via Planzer's own Impressum page (2026-07-04):
 * https://www.planzer.ch/de/impressum/ →
 *   "Planzer Transport AG / Lerzenstrasse 14 / 8953 Dietikon / Schweiz"
 * (listed under "Kontaktadresse & Hauptsitz").
 */
const HQ = {
  city: 'Dietikon',
  canton: 'ZH',
  postalCode: '8953',
  streetAddress: 'Lerzenstrasse 14',
  region: 'Zürich',
};

const SECTOR = 'Trasporti / Logistica';

/* ── Company Matchers ──────────────────────────────────────── */

export function isPlanzerJob(job) {
  const key = normalizeSpace(job?.companyKey || job?.company || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeSpace(job?.company || '').toLowerCase();
  const url = normalizeSpace(job?.url || '').toLowerCase();

  return (
    key === PLANZER_KEY ||
    key.startsWith('planzer') ||
    company.includes('planzer') ||
    url.includes('planzer.ch') ||
    url.includes('live.solique.ch/planzer')
  );
}

/**
 * Validate that a URL belongs to Planzer's own domain OR the Solique
 * tenant portal that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'planzer.ch' || host.endsWith('.planzer.ch')) return true;
    if (host === 'live.solique.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment Detection (logistics-tuned) ── */

function detectCategory(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(chauffeur|fahrer|conducente|conducteur|lkw|camion|kat\.?\s*c)/.test(t)) return 'Trasporti / Autisti';
  if (/\b(dispon|disposition|planning|planificat)/.test(t)) return 'Logistica';
  if (/\b(logist|magazz|lager|warehouse|pick|pack|sortier|paket|stückgut|stueckgut)/.test(t)) return 'Logistica';
  if (/\b(sachbearbeit|admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(ingegner|engineer|entwickl|developer|cobol|software|it[\s-]?|informatik)/.test(t)) return 'IT';
  if (/\b(techni|tecnic|mecanic|elektr|install|mechatron|betriebstechnik|unterhalt)/.test(t)) return 'Tecnica';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal(abteilung)?)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|teamleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalizeSpace(text).toLowerCase();
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|100%)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Workload parsing ("100%" or "80-100%") ───────────────────── */

function parseWorkload(raw = '') {
  const t = normalizeSpace(raw);
  const range = t.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*%/);
  if (range) return { min: Number(range[1]), max: Number(range[2]), label: t };
  const single = t.match(/(\d{1,3})\s*%/);
  if (single) return { min: Number(single[1]), max: Number(single[1]), label: t };
  return { min: null, max: null, label: t };
}

/* ── Address Resolution ───────────────────────────────────────── */

/**
 * Resolve street/postal/city/region for a job.
 *
 * Preference order:
 *   1. `detailLocationText` — parsed from the job's OWN Solique detail page
 *      (`.location-inner .location`, "STREET<br>PLZ CITY"), when available.
 *      This is the accurate, per-posting Planzer-group site address (HQ,
 *      Härkingen, Märstetten, Villmergen, Kölliken, Emmen, Buchs, ...).
 *   2. HQ fallback — used ONLY when the detail page couldn't be parsed
 *      AND the job's own resolved city TEXT matches the Dietikon HQ city
 *      regex (`/dietikon/i`). A same-canton (ZH) job in a different city
 *      (e.g. Buchs ZH) must NEVER inherit the HQ street — canton match
 *      alone is not sufficient (AGENTS.md Non-Negotiable #3).
 *
 * Exported so tests exercise the real implementation, not a copy.
 */
export function resolveAddress(cityText = '', detailLocationText = '') {
  // IMPORTANT: split on newlines BEFORE any whitespace-collapsing
  // normalization — normalizeSpace() folds \n into a plain space, which
  // would silently merge the street line into the "PLZ CITY" line and
  // break the parse below.
  const detailRaw = String(detailLocationText ?? '');
  if (detailRaw.trim()) {
    const lines = detailRaw
      .split('\n')
      .map((l) => normalizeSpace(l))
      .filter(Boolean);
    if (lines.length >= 2) {
      const cityLine = lines[lines.length - 1];
      const streetLines = lines.slice(0, -1).join(', ');
      const plzMatch = cityLine.match(/^(\d{4})\s+(.+)$/);
      if (plzMatch) {
        return {
          city: normalizeSpace(plzMatch[2]),
          postalCode: plzMatch[1],
          streetAddress: streetLines,
          region: '',
        };
      }
      // Unexpected shape (no 4-digit PLZ on the last line) — fall through
      // to the city-gated HQ fallback below rather than guessing.
    } else if (lines.length === 1) {
      const plzMatch = lines[0].match(/^(\d{4})\s+(.+)$/);
      if (plzMatch) {
        return {
          city: normalizeSpace(plzMatch[2]),
          postalCode: plzMatch[1],
          streetAddress: '',
          region: '',
        };
      }
    }
  }

  const city = normalizeSpace(cityText);
  const isDietikon = /dietikon/i.test(city);
  return {
    city: city || (isDietikon ? HQ.city : ''),
    postalCode: isDietikon ? HQ.postalCode : '',
    streetAddress: isDietikon ? HQ.streetAddress : '',
    region: isDietikon ? HQ.region : '',
  };
}

/* ── Listing parse ─────────────────────────────────────────── */

function parsePlanzerListing(html = '') {
  const out = [];
  const itemRe = /<div class="job">\s*<a\s+id="(\d+)"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const [, id, href, body] = m;
    const titleMatch = body.match(/<div class="jobtitle">([^<]*)<\/div>/);
    const workloadMatch = body.match(/<div class="workload">([^<]*)<\/div>/);
    const brandMatch = body.match(/<div class="brand">([^<]*)<\/div>/);
    const locationMatch = body.match(/<div class="location">([^<]*)<\/div>/);
    const langMatch = body.match(/<div class="language">([^<]*)<\/div>/);

    const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1])) : '';
    if (!title || title.length < 3) continue;

    const detailUrl = href.startsWith('http') ? href : `${PORTAL_BASE}${href}`;
    out.push({
      id,
      detailUrl,
      title,
      workloadRaw: workloadMatch ? normalizeSpace(decodeEntities(workloadMatch[1])) : '',
      brand: brandMatch ? normalizeSpace(decodeEntities(brandMatch[1])) : '',
      location: locationMatch ? normalizeSpace(decodeEntities(locationMatch[1])) : '',
      lang: langMatch ? normalizeSpace(decodeEntities(langMatch[1])).toLowerCase() : '',
    });
  }
  return out;
}

/* ── Detail page parse ─────────────────────────────────────── */

function extractDivClass(html, className) {
  const re = new RegExp(`<div class="${className}"[^>]*>([\\s\\S]*?)<\\/div>`);
  const m = html.match(re);
  return m ? m[1] : '';
}

function extractAllDivClass(html, className) {
  const re = new RegExp(`<div class="${className}"[^>]*>([\\s\\S]*?)<\\/div>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function htmlBlockToText(block = '') {
  const withBreaks = block
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return normalizeSpace(decodeEntities(withBreaks).replace(/\n{2,}/g, '\n'));
}

function parseLocationBlock(html = '') {
  // Target the `.location` div directly (NOT `.location-inner`, which also
  // wraps a leading `<h3 class="location-title">Arbeitsort</h3>` heading —
  // stripping just the outer tags there would leak "Arbeitsort" in as a
  // spurious first line). `.location`'s own content is plain (only <br>/
  // <span class="street"> inside, no nested <div>), so a direct non-greedy
  // match up to its first closing </div> is safe.
  const locationMatch = html.match(/<div class="location">([\s\S]*?)<\/div>/);
  if (!locationMatch) return '';
  const withBreaks = locationMatch[1]
    .replace(/<span class="street">([\s\S]*?)<\/span>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // IMPORTANT: split on newlines BEFORE normalizeSpace() — it folds \n into
  // a plain space, which would merge the street line into the "PLZ CITY"
  // line (same class of bug fixed in resolveAddress() above).
  return decodeEntities(withBreaks)
    .split('\n')
    .map((l) => normalizeSpace(l))
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract detail-page content. Deliberately EXCLUDES `.contact` /
 * `.contact-wrapper` (named HR contact + direct phone — PII, see header).
 */
function extractDetailContent(html = '') {
  const intro = htmlBlockToText(extractDivClass(html, 'intro'));
  const tasks = htmlBlockToText(extractDivClass(html, 'tasks-back'));
  const profile = htmlBlockToText(extractDivClass(html, 'profile-back'));
  const benefitBacks = extractAllDivClass(html, 'benefit-back').map((b) => htmlBlockToText(b));
  const companyPortrait = htmlBlockToText(extractDivClass(html, 'company-portrait'));

  const sections = [];
  if (intro) sections.push(intro);
  if (tasks) sections.push(`Aufgaben:\n${tasks}`);
  if (profile) sections.push(`Profil:\n${profile}`);
  if (benefitBacks.length) sections.push(`Benefits:\n${benefitBacks.map((b) => `• ${b}`).join('\n')}`);
  if (companyPortrait) sections.push(companyPortrait);

  const locationText = parseLocationBlock(html);

  return {
    description: sections.join('\n\n').slice(0, MAX_DETAIL_CHARS),
    locationText,
  };
}

async function fetchDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { description: '', locationText: '' };
    return extractDetailContent(html);
  } catch (err) {
    console.warn(` ⚠️ Planzer detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return { description: '', locationText: '' };
  }
}

/* ── Fetch all jobs ────────────────────────────────────────── */

/**
 * Fetch all Planzer jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by
 * the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPlanzerJobs() {
  console.log(`🔍 Fetching ${PLANZER_COMPANY_NAME} jobs (Solique tenant "${TENANT}")`);
  console.log(`   Portal: ${LISTING_URL}\n`);

  const html = await fetchHtml(LISTING_URL);
  const rows = parsePlanzerListing(html);
  console.log(`   ✓ ${rows.length} Solique tiles parsed`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));

    const { description: detailDescription, locationText } = await fetchDetail(r.detailUrl);
    const { city, postalCode, streetAddress, region } = resolveAddress(r.location, locationText);

    const hasLocationText = !!(normalizeSpace(r.location) || normalizeSpace(locationText));
    const inferredCanton = inferSwissTargetCanton(city) || inferSwissTargetCanton(r.location);
    if (hasLocationText && !inferredCanton) {
      // Location text present but doesn't resolve to any known Swiss canton —
      // never fabricate the Dietikon HQ canton for a job that isn't
      // positively there (AGENTS.md Non-Negotiable #3). Skip it.
      console.warn(` ⚠️ Planzer: skipping unresolvable location "${r.location}" (${r.title})`);
      continue;
    }
    const canton = inferredCanton || HQ.canton;

    const workload = parseWorkload(r.workloadRaw);
    const brandNote = r.brand && r.brand.toLowerCase() !== PLANZER_COMPANY_NAME.toLowerCase()
      ? `Marke der Planzer-Gruppe: ${r.brand}.`
      : '';

    const summaryPieces = [
      brandNote,
      city ? `Standort: ${city}` : '',
      workload.label ? `Pensum: ${workload.label}` : '',
    ].filter(Boolean);

    const description = detailDescription && detailDescription.split(/\s+/).length >= 30
      ? [brandNote, detailDescription].filter(Boolean).join('\n\n')
      : [
        ...summaryPieces,
        `${PLANZER_COMPANY_NAME} Transport AG — Schweizer Familienunternehmen für Transport- und Lagerlogistik seit 1936 (HQ Dietikon, ZH).`,
      ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, r.lang === 'de' ? 'de' : 'de');
    const jobSlug = slugify(`${r.title} ${PLANZER_KEY} ${city || 'dietikon'}`);
    const urlHash = createHash('sha1').update(r.detailUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${r.title} ${description} ${workload.label}`);

    jobs.push({
      // ── Required fields ──
      id: `${PLANZER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PLANZER_COMPANY_NAME,
      companyKey: PLANZER_KEY,
      companyDomain: PLANZER_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city || r.location || HQ.city,
      canton,
      url: r.detailUrl,
      source: `${PLANZER_COMPANY_NAME} Dedicated Parser (Solique)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || HQ.city,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${r.title}`),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(r.title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.detailUrl,
      externalId: r.id,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${PLANZER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
