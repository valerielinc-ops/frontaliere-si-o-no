#!/usr/bin/env node
/**
 * Suchtfachstelle Zürich — dedicated parser.
 *
 * Listing: https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen
 *   Single-page listing on the Craft CMS site. Each open position is a
 *   sibling anchor of the form
 *
 *     <a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-{slug}">…</a>
 *
 * Detail: https://www.suchtfachstelle.zuerich/stellenausschreibung-{slug}
 *   The job body is rendered inside a section starting at the H1
 *   "Die Suchtfachstelle Zürich als Arbeitgeberin" and ending at the
 *   "Online-Bewerbung" form. The <title> tag carries the full job title
 *   ("Stellenausschreibung: …"); we strip the prefix.
 *
 * Org HQ: Josefstrasse 91, 8005 Zürich (BS-Quartier, Nähe HB Zürich).
 * Single small org, typically 0-2 open positions at a time.
 */
import { sourcePostingDateFields, mergeSourcePostingDates } from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { slugify, stripScriptsAndStyles } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SUCHTFACHSTELLE_ZUERICH_KEY = 'suchtfachstelle-zuerich';
export const SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME = 'Suchtfachstelle Zürich';
export const SUCHTFACHSTELLE_ZUERICH_COMPANY_DOMAIN = 'suchtfachstelle.zuerich';
export const SUCHTFACHSTELLE_ZUERICH_CAREERS_URL =
  'https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen';

const HQ_CITY = 'Zürich';
const HQ_POSTAL_CODE = '8005';
const HQ_CANTON = 'ZH';

const DETAIL_DELAY_MS = 450;

/* ── Company matchers ──────────────────────────────────────── */

export function isSuchtfachstelleZuerichJob(job) {
  if (job?.companyKey === SUCHTFACHSTELLE_ZUERICH_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('suchtfachstelle zürich') || company.includes('suchtfachstelle zuerich')) {
    return true;
  }
  const url = String(job?.url || '').toLowerCase();
  return url.includes('suchtfachstelle.zuerich');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'suchtfachstelle.zuerich' || host.endsWith('.suchtfachstelle.zuerich');
  } catch {
    return false;
  }
}

/* ── Title cleaner ─────────────────────────────────────────── */

export function cleanSfsTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  text = text.replace(/^Stellenausschreibung\s*[:：]\s*/i, '').trim();
  return text;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the offene-stellen HTML and return one row per /stellenausschreibung-*
 * posting.
 *
 * @param {string} html
 * @returns {Array<{ url: string, slug: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const re =
    /href\s*=\s*["']((?:https?:\/\/(?:www\.)?suchtfachstelle\.zuerich)?\/stellenausschreibung-([a-z0-9-]+))["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rawUrl = m[1];
    const url = rawUrl.startsWith('/')
      ? new URL(rawUrl, SUCHTFACHSTELLE_ZUERICH_CAREERS_URL).href
      : rawUrl;
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ url, slug });
  }
  return out;
}

/**
 * Scan vacancy anchors independently of parseListing's canonical-row regex.
 * A source vacancy must veto an authoritative empty snapshot even when its
 * href carries tracking parameters, a fragment, a trailing slash, or uses
 * an otherwise valid relative/unquoted attribute form that row parsing does
 * not normalize yet.
 */
export function hasSuchtfachstelleZuerichVacancyAnchor(html = '') {
  const cleaned = stripScriptsAndStyles(html);
  const re = /\bhref\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const rawHref = decodeEntities(m[1] ?? m[2] ?? '').trim();
    if (!rawHref) continue;
    let url;
    try {
      url = new URL(rawHref, SUCHTFACHSTELLE_ZUERICH_CAREERS_URL);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (
      (host !== 'suchtfachstelle.zuerich' && host !== 'www.suchtfachstelle.zuerich')
      || !/^\/stellenausschreibung-/i.test(url.pathname)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * The jobs page keeps its employer copy and the jobs section rendered even
 * when there are no open positions. Those two source-owned landmarks prove
 * that the page was read completely; a bare zero from a partial or redirected
 * page must remain fail-closed.
 */
export function isSuchtfachstelleZuerichEmptyListing(html = '') {
  if (!html || parseListing(html).length > 0 || hasSuchtfachstelleZuerichVacancyAnchor(html)) {
    return false;
  }
  const cleaned = stripScriptsAndStyles(html);
  const employerHeading = /<h1\b[^>]*class=["'][^"']*\bintro__title\b[^"']*["'][^>]*>\s*Die\s+Suchtfachstelle\s+Zürich\s+als\s+Arbeitgeberin\s*<\/h1>/i.test(cleaned);
  const jobsSection = cleaned.match(
    /<section\b[^>]*class=["'][^"']*\blinks\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
  );
  const jobsSectionText = jobsSection
    ? normalizeSpace(decodeEntities(jobsSection[1].replace(/<[^>]+>/g, ' '))).toLowerCase()
    : '';
  return employerHeading
    && jobsSectionText.includes('wir bieten ihnen jobs mit vielfältigen und sinnvollen aufgaben');
}

/* ── Detail parsing ───────────────────────────────────────── */

export function parseDetail(html = '') {
  if (!html) return { title: '', body: '' };
  const titleMatch = stripScriptsAndStyles(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleRaw = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  const title = cleanSfsTitle(titleRaw);
  // Body: the ad is the page's `section.richtext` (lead, role heading,
  // "Ihre Aufgaben" / "Ihr Profil" lists, "Unser Angebot", deadline), after
  // the `section.intro` lead line and before the application form. It is
  // read line by line so its lists survive (they used to be flattened into
  // one paragraph and cut at 6000 characters). The paragraph naming the
  // contact persons and their phone number is left out.
  let body = '';
  const cleaned = stripScriptsAndStyles(html);
  const introMain = /<p\b[^>]*class="[^"]*\bintro__main\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(cleaned);
  const richtext = [...cleaned.matchAll(/<section\b[^>]*class="[^"]*\brichtext\b[^"]*"[^>]*>([\s\S]*?)<\/section>/gi)]
    .map((m) => m[1].replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?nähere Auskünfte[\s\S]*?<\/p>/gi, ''))
    .map((section) => htmlToTextLines(section))
    .filter(Boolean);
  if (richtext.length > 0) {
    body = [introMain ? htmlToTextLines(introMain[1]) : '', ...richtext].filter(Boolean).join('\n\n');
  } else {
    // Older template without the richtext section: everything between the
    // H1 "Die Suchtfachstelle Zürich als Arbeitgeberin" and the form.
    const startIdx = html.indexOf('Die Suchtfachstelle Zürich als Arbeitgeberin');
    if (startIdx > 0) {
      const chunk = html.slice(startIdx);
      const endIdx = chunk.search(/Online-Bewerbung|fui-bew/);
      body = htmlToTextLines(endIdx > 0 ? chunk.slice(0, endIdx) : chunk.slice(0, 12000));
    }
  }
  return { title, body };
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllSuchtfachstelleZuerichJobs() {
  console.log(`🏥 Fetching ${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${SUCHTFACHSTELLE_ZUERICH_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(SUCHTFACHSTELLE_ZUERICH_CAREERS_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} listing rows parsed`);
  if (rows.length === 0) {
    if (isSuchtfachstelleZuerichEmptyListing(listingHtml)) {
      return markAuthoritativeEmptySnapshot(
        [],
        'Suchtfachstelle Zürich rendered its employer heading and empty jobs section with no vacancy links',
      );
    }
    return [];
  }

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    let detail = { title: '', body: '' };
    try {
      const html = await fetchHtml(row.url);
      detail = { ...parseDetail(html), ...sourcePostingDateFields(extractJobPostingLd(html)?.datePosted) };
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    const title = detail.title || row.slug.replace(/-/g, ' ');
    // Only the ad's own text: the organisation blurb this parser used to
    // prepend ("Die Suchtfachstelle Zürich ist Anlauf- und Beratungsstelle …
    // Stelle: …") was its own wording, not the employer's.
    const description = detail.body || '';
    if (description.length < 200) {
      console.warn(`  ⚠️ ${row.url}: no readable ad text — skipped this run.`);
      continue;
    }

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${SUCHTFACHSTELLE_ZUERICH_KEY}`);
    const urlHash = createHash('sha1').update(row.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SUCHTFACHSTELLE_ZUERICH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME,
      companyKey: SUCHTFACHSTELLE_ZUERICH_KEY,
      companyDomain: SUCHTFACHSTELLE_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: row.url,
      source: `${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*%\b/.test(title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Suchtberatung / Sozialwesen',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
