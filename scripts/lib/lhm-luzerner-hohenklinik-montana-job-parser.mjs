#!/usr/bin/env node
/**
 * Luzerner Höhenklinik Montana (LHM) — rehab clinic operated by Luzerner
 * Kantonsspital (LUKS) on the Crans-Montana plateau (VS, 1400 m a.s.l.).
 * Specialised in pulmonary + cardiovascular rehabilitation, psychosomatic
 * medicine and a sleep-medicine centre. German-speaking workplace inside
 * the francophone Valais — sits in our Valais coverage scope.
 *
 * Public career page (DE):
 *   https://www.lhm.ch/de/allgemein/jobs
 *
 * The listing is a static HTML page hosted on lhm.ch (no third-party ATS,
 * no AJAX). Each open position is a child page under `/de/allgemein/jobs/{slug}`
 * referenced as a list of <a href="…/jobs/{slug}"> links inside the same
 * portlet block. We:
 *
 *   1. fetch the listing page
 *   2. extract every child link under `/de/allgemein/jobs/{slug}` (excluding
 *      the `jobs-neu` overview placeholder and the `spontanbewerbung` link)
 *   3. fetch each detail page and pull the body text after the first <h1>
 *
 * Polite delay: 250 ms between detail-page fetches.
 */
import { extractJobPostingsLd } from './jsonld-jobposting.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripScriptsAndStyles } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  extractBalancedTagBlockWithStatus,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';

export const LHM_KEY = 'lhm-luzerner-hohenklinik-montana';
export const LHM_COMPANY_NAME = 'Luzerner Höhenklinik Montana';
export const LHM_COMPANY_DOMAIN = 'lhm.ch';

const LISTING_URL = 'https://www.lhm.ch/de/allgemein/jobs';
const DETAIL_DELAY_MS = 250;
const EXCLUDED_SLUGS = new Set(['jobs-neu', 'spontanbewerbung', '']);

export function isLhmJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === LHM_KEY) return true;
  return url.includes('lhm.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lhm.ch' || host.endsWith('.lhm.ch');
  } catch {
    return false;
  }
}

export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(https?:\/\/(?:www\.)?lhm\.ch\/de\/allgemein\/jobs\/([a-z0-9][a-z0-9-]*?))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const slug = (m[2] || '').toLowerCase();
    if (!slug || EXCLUDED_SLUGS.has(slug)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, slug });
  }
  return out;
}

function extractH1(html) {
  const m = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

/**
 * The vacancy lives in the page's main column, `<div class="content_overflow">`
 * (introduction + tasks/profile/offer lists + application paragraph). The
 * right column (`#portlets_right`) holds the contact-person widgets, which the
 * old "everything after </h1>" slice put at the TOP of every description
 * ("Pascale Baray Leiterin Hotellerie Auskunft: …") before the posting itself.
 */
function extractMainColumnText(html) {
  const open = /<div\b[^>]*\bclass="[^"]*\bcontent_overflow\b[^"]*"[^>]*>/i.exec(html);
  if (!open) return '';
  const { html: inner, complete } = extractBalancedTagBlockWithStatus(
    html.slice(open.index + open[0].length),
    'div',
    60000,
  );
  if (!complete) return '';
  const cleaned = stripScriptsAndStyles(inner)
    // Back-to-listing link ("Zurück" button or plain "zurück" anchor).
    .replace(/<a\b[^>]*>\s*zurück\s*<\/a>/gi, '');
  return htmlToTextLines(cleaned);
}

export function extractBodyText(html) {
  const main = extractMainColumnText(html);
  if (main) return main;
  // The detail body is rendered as a stack of <p>/<h2>/<ul> elements after
  // the <h1>. Take the substring from the closing </h1> to the next footer;
  // without a footer there is no delimited body.
  const h1End = html.search(/<\/h1>/i);
  if (h1End < 0) return '';
  const tail = html.slice(h1End + '</h1>'.length);
  const stopIdx = tail.search(/<footer|<div[^>]*class="[^"]*footer/i);
  // No footer marker: no delimited body. The text has no length cap
  // (issue 5253), so the page tail after the h1 is never published.
  if (stopIdx <= 0) return '';
  const block = tail.slice(0, stopIdx);
  // Strip nav portlets ("Suchen", "Sie sind hier:", contact widget,
  // breadcrumbs) — the LHM portal wraps everything in
  // `<div class="portlet-…">` blocks. Drop any portlet block with class
  // "search" or "breadcrumb".
  const cleaned = block
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<div[^>]*class="[^"]*(?:search|breadcrumb|navigation)[^"]*"[\s\S]*?<\/div>/gi, '');
  const text = htmlToText(cleaned);
  return normalizeSpace(text);
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    const title = extractH1(html);
    const body = extractBodyText(html);
    const postings = extractJobPostingsLd(html);
    const matching = postings.filter((posting) => {
      if (!title || normalizeSpace(posting.title || '').toLowerCase() !== title.toLowerCase()) return false;
      const urls = [posting.url, posting.sameAs].filter(Boolean);
      if (!urls.length) return postings.length === 1;
      try { return urls.every((value) => new URL(value, url).href === new URL(url).href); }
      catch { return false; }
    });
    return { title, body, ...sourcePostingDateFields(matching.length === 1 ? matching[0].datePosted : '') };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { title: '', body: '', ...sourcePostingDateFields() };
  }
}

function slugToTitle(slug) {
  return slug
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchAllLhmJobs() {
  console.log(`🏥 Fetching ${LHM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }

  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} job links discovered`);
  if (!rows.length) return [];

  const jobs = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = await fetchDetail(r.url);
    const title = detail.title || slugToTitle(r.slug);
    if (!title || title.length < 3) continue;

    // The detail's own text, whatever its length. Under 30 words the crawler
    // used to put a paragraph of its own on the clinic in front of it (or in
    // its place); a detail without text now gives no description and the job
    // takes the pipeline's thin-source path.
    const description = detail.body || '';

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${LHM_KEY} crans-montana`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${LHM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LHM_COMPANY_NAME,
      companyKey: LHM_KEY,
      companyDomain: LHM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: 'Crans-Montana',
      canton: 'VS',
      url: r.url,
      source: `${LHM_COMPANY_NAME} Dedicated Parser (Custom HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Crans-Montana',
      addressRegion: 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '3963',
      category: detectHealthcareCategory(`${title} ${description.slice(0, 600)}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${title} ${description.slice(0, 400)}`),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(detail.datePosted),
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${LHM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
