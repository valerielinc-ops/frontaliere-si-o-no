#!/usr/bin/env node
/**
 * REHAB Basel — Klinik für Neurorehabilitation und Paraplegiologie.
 *
 * Public career site: https://www.rehab.ch/karriere
 * Talentsoft career portal: https://rehabbasel-career.talent-soft.com/
 * All-jobs listing:    /stelle/liste-aller-stellen.aspx?all=1&mode=list
 *
 * Talentsoft (Cegid) ATS. Job entries are server-rendered as `<li class="ts-offer-list-item">`
 * with the title link, posted date, and reference number.
 */
import { createHash } from 'node:crypto';
import { detectLang, isCivilServiceListing } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  locateTagByAttribute,
  extractBalancedTagBlock,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';

export const REHAB_BASEL_KEY = 'rehab-basel';
export const REHAB_BASEL_COMPANY_NAME = 'REHAB Basel';
export const REHAB_BASEL_COMPANY_DOMAIN = 'rehab.ch';

const PORTAL_BASE = 'https://rehabbasel-career.talent-soft.com';
const LISTING_URL = `${PORTAL_BASE}/stelle/liste-aller-stellen.aspx?all=1&mode=list`;

export function isRehabBaselJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === REHAB_BASEL_KEY
    || url.includes('rehab.ch')
    || url.includes('rehabbasel-career.talent-soft.com');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rehab.ch' || host.endsWith('.rehab.ch') || host === 'rehabbasel-career.talent-soft.com';
  } catch {
    return false;
  }
}

export function parseTalentsoftListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<li class="ts-offer-list-item[^"]*"\s+title="[^"]*"\s+onclick="location\.href='([^']+)';">[\s\S]*?<a class="ts-offer-list-item__title-link[^"]*"\s+href="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<ul class="ts-offer-list-item__description[^"]*">\s*<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = rx.exec(html))) {
    const href = m[1];
    const detailUrl = href.startsWith('http') ? href : `${PORTAL_BASE}${href}`;
    const fullTitle = normalizeSpace(decodeEntities(m[3]));
    const title = normalizeSpace(decodeEntities(m[4].replace(/<[^>]+>/g, '')));
    const dateText = normalizeSpace(decodeEntities(m[5].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    // Extract Ref number from full title (e.g. "(Ref. : 2026-282)")
    const refMatch = fullTitle.match(/Ref\.\s*:\s*([0-9-]+)/i);
    const ref = refMatch ? refMatch[1] : '';
    const key = ref || detailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ detailUrl, title, ref, dateText, fullTitle });
  }
  return out;
}

/**
 * The posting's text on its Talentsoft detail page: every field of
 * `#contenu-ficheoffre` ("Über uns", "Stellenbezeichnung", "Ihr
 * Aufgabenbereich", "Ihr Profil", "Sie finden bei uns", "Stelle zu besetzen
 * ab", …) as "<Überschrift>" followed by its text, lists kept. The block's
 * header (logo, Kennziffer) and fields without text (the embedded video) are
 * left out.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseRehabBaselDetail(html = '') {
  const container = locateTagByAttribute(String(html || ''), 'id="contenu-ficheoffre"', { skipVoidTags: true });
  if (!container) return '';
  const block = extractBalancedTagBlock(container.rest, container.tagName, 80000);
  const sections = [];
  const fieldRe = /<h3[^>]*>((?:(?!<\/?h3)[\s\S])*?)<\/h3>\s*<(div|p)\s+id="fld[^"]*"[^>]*>/gi;
  let m;
  while ((m = fieldRe.exec(block))) {
    const heading = normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
    const body = extractBalancedTagBlock(block.slice(m.index + m[0].length), m[2], 40000)
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    const text = htmlToTextLines(body);
    if (!text) continue;
    sections.push(heading ? `${heading}\n${text}` : text);
  }
  return sections.join('\n\n').trim();
}

/** Fragments only the crawler's former description wrote. */
export const REHAB_BASEL_FABRICATED_DESCRIPTION_RE =
  /Bewerbung über das Talentsoft-Karriereportal von REHAB Basel|— Klinik für Neurorehabilitation und Paraplegiologie, Basel \(4055, BS\), Schweiz\./;

const DETAIL_DELAY_MS = 300;

function parseSwissDate(raw) {
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export async function fetchAllRehabBaselJobs({ fetchPage = fetchHtml, delayMs = DETAIL_DELAY_MS } = {}) {
  console.log(`🏥 Fetching ${REHAB_BASEL_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);
  const html = await fetchPage(LISTING_URL);
  const items = parseTalentsoftListing(html);
  console.log(`  ✓ ${items.length} Talentsoft offers parsed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let skippedCivilService = 0;
  for (const it of items) {
    const title = it.title;
    // Skip Swiss compulsory civil-service (Zivildienst) placements — they
    // require Swiss citizenship and a conscription waiver, so they are
    // never accessible to cross-border workers. Their thin descriptions
    // also tend to trip the boilerplate guard when the listing pool is
    // small (see issue #685).
    if (isCivilServiceListing(title, it.fullTitle)) {
      skippedCivilService++;
      continue;
    }
    // The description is the posting's own text on its detail page. The
    // crawler used to never read that page and to write a description of its
    // own ("<Titel> bei REHAB Basel — Klinik für …, Basel (4055, BS),
    // Schweiz." and "• Referenz / • Standort / • Fachgebiet / • Bewerbung über
    // das Talentsoft-Karriereportal…"). A detail without text gives no
    // description and the job takes the pipeline's thin-source path.
    if (jobs.length > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let description = '';
    try {
      description = parseRehabBaselDetail(await fetchPage(it.detailUrl));
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed for "${title}": ${err?.message || err}`);
    }
    const postedDate = parseSwissDate(it.dateText) || todayIso;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${REHAB_BASEL_KEY} basel`);
    const urlHash = createHash('sha1').update(it.detailUrl).digest('hex').slice(0, 12);
    jobs.push({
      id: `${REHAB_BASEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: REHAB_BASEL_COMPANY_NAME,
      companyKey: REHAB_BASEL_KEY,
      companyDomain: REHAB_BASEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Basel',
      canton: 'BS',
      url: it.detailUrl,
      source: 'REHAB Basel Dedicated Parser (Talentsoft)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Basel',
      addressRegion: 'BS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4055',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: it.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  if (skippedCivilService > 0) {
    console.log(`  ⏭️  Skipped ${skippedCivilService} Zivildienst/civil-service listing(s) (not relevant for cross-border workers)`);
  }
  console.log(`📋 Total ${REHAB_BASEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
