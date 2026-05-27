#!/usr/bin/env node
/**
 * Clinique de la Plaine (Genève) — dedicated parser.
 *
 * Listing: https://laplaine.ch/jobs/
 *   WordPress (Divi + WP Show Posts plugin). Each open position is rendered as
 *
 *     <article class="wp-show-posts-single ...">
 *       <h2 class="wp-show-posts-entry-title">
 *         <a href="https://laplaine.ch/emploi/{slug}/" rel="bookmark">{TITLE}</a>
 *       </h2>
 *       <time class="wp-show-posts-entry-date" datetime="YYYY-MM-DDThh:mm:ss±HH:MM">…</time>
 *     </article>
 *
 * Detail: https://laplaine.ch/emploi/{slug}/
 *   The Divi page template emits the body inside `et_pb_module et_pb_post_content`
 *   followed by alternating "Votre mission / Votre profil / Nous offrons / Contact"
 *   sections wrapped in `et_pb_text_inner` blocks. We concatenate every
 *   `et_pb_text_inner` div on the page (in source order) — this gives us a clean
 *   structured description with section headers preserved.
 *
 * Clinic location: Avenue de la Roseraie 76 bis, 1205 Genève (GE).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CLINIQUE_DE_LA_PLAINE_KEY = 'clinique-de-la-plaine';
export const CLINIQUE_DE_LA_PLAINE_COMPANY_NAME = 'Clinique de la Plaine';
export const CLINIQUE_DE_LA_PLAINE_COMPANY_DOMAIN = 'laplaine.ch';

const LISTING_URL = 'https://laplaine.ch/jobs/';
const HQ_CITY = 'Genève';
const HQ_POSTAL_CODE = '1205';
const HQ_CANTON = 'GE';

const DETAIL_DELAY_MS = 350;

/* ── Company matchers ──────────────────────────────────────── */

export function isCliniqueDeLaPlaineJob(job) {
  if (job?.companyKey === CLINIQUE_DE_LA_PLAINE_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('clinique de la plaine') || company === 'la plaine') return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('laplaine.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'laplaine.ch' || host.endsWith('.laplaine.ch');
  } catch {
    return false;
  }
}

/* ── Parsing ───────────────────────────────────────────────── */

/**
 * Parse the listing HTML and return one row per open position.
 *
 * @param {string} html
 * @returns {Array<{ url: string, title: string, postedDate: string|null }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // Anchor in <h2 class="wp-show-posts-entry-title">. Some themes wrap the
  // anchor inside extra spans; capture href + visible text robustly.
  const re = /<h2\s+class="wp-show-posts-entry-title"[^>]*>\s*<a\s+href="(https:\/\/laplaine\.ch\/emploi\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const titleRaw = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    if (!titleRaw || titleRaw.length < 3) continue;
    // Try to recover the entry-date associated with this article. Search
    // forward up to ~2 KB for the nearest <time datetime="…">.
    const slice = html.slice(m.index, m.index + 2048);
    const dateMatch = slice.match(/<time\s+class="wp-show-posts-entry-date[^"]*"\s+datetime="([^"]+)"/i);
    const postedDate = dateMatch ? dateMatch[1].slice(0, 10) : null;
    out.push({ url, title: titleRaw, postedDate });
  }
  return out;
}

/**
 * Pull the structured description out of a Divi-rendered emploi page.
 * Strategy: concatenate every `<div class="et_pb_text_inner">…</div>` in source
 * order. The first one is the H1 (drop it), the rest are mission / profil /
 * offrons / contact sections. Strip HTML last so headings + list bullets
 * survive as plain text.
 */
export function parseDetailDescription(html = '') {
  const blocks = [];
  const re = /<div\s+class="et_pb_text_inner">([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1].trim();
    if (!inner) continue;
    blocks.push(inner);
  }
  if (blocks.length === 0) return '';
  // Drop the first block if it's just the H1 (always present on the Divi
  // template). Keep it if there's no H1 (defensive).
  const firstIsH1 = /^<h1[^>]*>/i.test(blocks[0]);
  const body = firstIsH1 ? blocks.slice(1) : blocks;
  // Join with double newline so htmlToText preserves paragraph spacing.
  const joined = body.join('\n\n');
  return normalizeSpace(htmlToText(joined).replace(/\n+/g, ' ')).slice(0, 6000);
}

/* ── Fetcher ───────────────────────────────────────────────── */

async function fetchDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    return parseDetailDescription(html);
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllCliniqueDeLaPlaineJobs() {
  console.log(`🏥 Fetching ${CLINIQUE_DE_LA_PLAINE_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} listing rows parsed`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const description = await fetchDetail(r.url);
    const fallback = `${r.title} à la ${CLINIQUE_DE_LA_PLAINE_COMPANY_NAME}, ${HQ_CITY} (${HQ_CANTON}). Établissement à taille humaine spécialisé en chirurgie ambulatoire et hospitalisations de courte durée au centre-ville de Genève.`;
    const safeDescription =
      description && description.split(/\s+/).length >= 30
        ? description
        : [fallback, description].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(safeDescription || r.title, 'fr');
    const jobSlug = slugify(`${r.title} ${CLINIQUE_DE_LA_PLAINE_KEY} ${HQ_CITY}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CLINIQUE_DE_LA_PLAINE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLINIQUE_DE_LA_PLAINE_COMPANY_NAME,
      companyKey: CLINIQUE_DE_LA_PLAINE_KEY,
      companyDomain: CLINIQUE_DE_LA_PLAINE_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: r.url,
      source: `${CLINIQUE_DE_LA_PLAINE_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${r.title} ${safeDescription.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(r.title)
        ? 'part-time'
        : 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${safeDescription.slice(0, 500)}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: r.postedDate || todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${CLINIQUE_DE_LA_PLAINE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL, HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
