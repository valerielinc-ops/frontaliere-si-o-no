#!/usr/bin/env node
/**
 * Klinik Seeschau (Kreuzlingen, TG) job parser.
 *
 * Public career page: https://www.klinik-seeschau.ch/karriere/offene-stellen.html/59
 *
 * Klinik Seeschau AG is an independent private acute hospital with 56 beds
 * and ~110 staff in Kreuzlingen on Lake Constance (canton Thurgau). Member
 * of SLH (Swiss Leading Hospitals). Specialities: gynaecology, orthopaedics,
 * visceral & hand surgery, plastic/reconstructive surgery, urology and
 * anaesthesia/pain therapy.
 *
 * The career page is a Joomla SP Page Builder listing. Each job lives in a
 * `<li class="mod-entry">` block. The H2 carries the title; the
 * `<div class="mod-entry-desc news-description">` carries the full posting
 * body (Aufgaben, Profil, Angebot, Über uns, Bewerbungsadresse). No detail
 * page — the listing IS the detail. The last entry is a generic
 * "Spontanbewerbung" which we skip.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const KLINIK_SEESCHAU_KEY = 'klinik-seeschau';
export const KLINIK_SEESCHAU_COMPANY_NAME = 'Klinik Seeschau';
export const KLINIK_SEESCHAU_COMPANY_DOMAIN = 'klinik-seeschau.ch';
export const KLINIK_SEESCHAU_CAREERS_URL =
  'https://www.klinik-seeschau.ch/karriere/offene-stellen.html/59';

const HQ_CITY = 'Kreuzlingen';
const HQ_POSTAL = '8280';
const HQ_CANTON = 'TG';

// Generic / non-vacancy entries we don't want to index as real jobs.
const SKIP_TITLE_PATTERNS = [
  /^spontanbewerbung/i,
  /^initiativbewerbung/i,
];

export function isKlinikSeeschauJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return (
    job?.companyKey === KLINIK_SEESCHAU_KEY ||
    url.includes('klinik-seeschau.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === KLINIK_SEESCHAU_COMPANY_DOMAIN ||
      host.endsWith(`.${KLINIK_SEESCHAU_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

function isSkipTitle(title) {
  return SKIP_TITLE_PATTERNS.some((rx) => rx.test(String(title || '').trim()));
}

/**
 * Block-text extraction with whitespace normalisation and bullet preservation.
 */
function blockToText(htmlFragment = '') {
  return decodeEntities(
    String(htmlFragment || '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|tr|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/**
 * Parse the Seeschau career listing HTML.
 * @returns {Array<{title:string, descriptionHtml:string, descriptionText:string, anchorId:string}>}
 */
export function parseKlinikSeeschauListing(html = '') {
  const out = [];
  // 1) Operate on the full HTML. `<li class="mod-entry">` is unique to the
  //    listing widget, so we don't need to bound it inside the outer `<ul>`.
  //    Bounding inside the outer `<ul>` is unreliable because each entry can
  //    nest its own `<ul>` bullet lists, which trip naive non-greedy matchers.
  const listing = html;

  // 2) Split the listing by the entry-open token. The first chunk before the
  //    first `<li class="mod-entry">` is dropped.
  const entryOpen = /<li[^>]*class="[^"]*\bmod-entry\b[^"]*"[^>]*>/g;
  const positions = [];
  let m;
  while ((m = entryOpen.exec(listing))) positions.push(m.index + m[0].length);
  if (positions.length === 0) return out;

  // 3) For each entry, take the slice from the open-tag's end to the next
  //    open-tag's start (or end of listing for the last entry). The slice
  //    embeds the entry's <h2> title + <div class="mod-entry-desc"> body,
  //    plus any nested <ul>/<li>/<div class="news-bewerbung">.
  let idx = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end =
      i + 1 < positions.length
        ? listing.lastIndexOf('<li', positions[i + 1])
        : listing.length;
    const inner = listing.slice(start, end);

    const titleMatch = inner.match(
      /<h2[^>]*class="[^"]*\bmod-entry-title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i,
    );
    if (!titleMatch) continue;
    const title = normalizeSpace(
      decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')),
    );
    if (!title || isSkipTitle(title)) continue;

    // The desc <div> can contain a nested <div class="news-bewerbung"> at the
    // very end. Take everything from the opening `<div class="mod-entry-desc">`
    // up to the LAST closing `</div>` in the entry slice.
    const descOpen = inner.search(
      /<div[^>]*class="[^"]*\bmod-entry-desc\b[^"]*"[^>]*>/i,
    );
    let descriptionHtml = '';
    if (descOpen !== -1) {
      const afterOpen = inner.slice(descOpen).replace(
        /^<div[^>]*class="[^"]*\bmod-entry-desc\b[^"]*"[^>]*>/i,
        '',
      );
      const closeIdx = afterOpen.lastIndexOf('</div>');
      descriptionHtml = closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx);
    }
    const descriptionText = blockToText(descriptionHtml);
    out.push({
      title,
      descriptionHtml,
      descriptionText,
      anchorIndex: idx,
    });
    idx += 1;
  }
  return out;
}

export async function fetchAllKlinikSeeschauJobs() {
  console.log(`🏥 Fetching ${KLINIK_SEESCHAU_COMPANY_NAME} jobs`);
  console.log(`   Careers: ${KLINIK_SEESCHAU_CAREERS_URL}\n`);
  const html = await fetchHtml(KLINIK_SEESCHAU_CAREERS_URL);
  const items = parseKlinikSeeschauListing(html);
  console.log(`  ✓ ${items.length} job entries parsed (skipping Spontanbewerbung)`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const baseText = it.descriptionText || it.title;
    const description = [
      it.descriptionText,
      `${KLINIK_SEESCHAU_COMPANY_NAME} — Akutspital, ${HQ_CITY} (${HQ_CANTON}), Schweiz.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const sourceLang = detectLang(baseText, 'de');
    const jobSlug = slugify(`${it.title} ${KLINIK_SEESCHAU_KEY} ${HQ_CITY}`);
    // Stable per-title hash → if the listing reorders, anchor index drifts
    // but title-based hash stays stable.
    const stableId = createHash('sha1')
      .update(`${KLINIK_SEESCHAU_KEY}:${it.title.toLowerCase()}`)
      .digest('hex')
      .slice(0, 12);
    const jobUrl = `${KLINIK_SEESCHAU_CAREERS_URL}#job-${stableId}`;

    jobs.push({
      id: `${KLINIK_SEESCHAU_KEY}-${stableId}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_SEESCHAU_COMPANY_NAME,
      companyKey: KLINIK_SEESCHAU_KEY,
      companyDomain: KLINIK_SEESCHAU_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: jobUrl,
      source: `${KLINIK_SEESCHAU_COMPANY_NAME} Dedicated Parser (Joomla SPB)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL,
      category: detectHealthcareCategory(it.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: KLINIK_SEESCHAU_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(
    `📋 Total ${KLINIK_SEESCHAU_COMPANY_NAME} jobs discovered: ${jobs.length}`,
  );
  return jobs;
}
