#!/usr/bin/env node
/**
 * Center da Sanadad Savognin (CDS) job parser — custom HTML.
 *
 * Center da Sanadad Savognin SA is a small Romansh/German-speaking
 * hospital (Akut-, Reha- und Pflegeabteilung) in Savognin (Surses, GR),
 * postal 7460. No ATS — the careers page is a hand-edited static page
 * served from the corporate website.
 *
 * Public career site:
 *   https://cds-savognin.ch/DE/stellen.html
 *
 * The page is a single HTML file with one section per vacancy:
 *
 *   <h3 id="subtitle_DE:{NNN}:text:idtext">{title}</h3>
 *   <div id="text1_DE:{NNN}:text:idtext">{pensum + start-date snippet}</div>
 *   <div id="text2_DE:{NNN}:text:idtext">{contact + apply CTA}</div>
 *   [optional] <a class="filelink pdfLink" href="/uploads/files/…pdf">…</a>
 *
 * The numeric ID (NNN) is stable across crawls (CMS internal ID) — we
 * use it as the canonical jobId. The site also runs Weglot for
 * EN/IT translations; we always read the DE source page (canonical).
 *
 * Spontaneous-applications blocks are filtered out (no real vacancy).
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
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CDS_SAVOGNIN_KEY = 'cds-savognin';
export const CDS_SAVOGNIN_COMPANY_NAME = 'Center da Sanadad Savognin';
export const CDS_SAVOGNIN_COMPANY_DOMAIN = 'cds-savognin.ch';

const PUBLIC_CAREER_URL = 'https://cds-savognin.ch/DE/stellen.html';
const DEFAULT_CITY = 'Savognin';
const DEFAULT_CANTON = 'GR';
const DEFAULT_POSTAL = '7460';

const SPONTANEOUS_RE = /spontanbewerbung|initiativ\s*bewerbung|spontaneous/i;

/* ── Company matchers ──────────────────────────────────────── */

export function isCdsSavogninJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === CDS_SAVOGNIN_KEY ||
    key.startsWith('cds-savognin') ||
    company.includes('center da sanadad') ||
    company.includes('cds savognin') ||
    company.includes('spital savognin') ||
    url.includes('cds-savognin.ch') ||
    url.includes('spital-savognin.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'cds-savognin.ch' || host.endsWith('.cds-savognin.ch')) return true;
    if (host === 'spital-savognin.ch' || host.endsWith('.spital-savognin.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Parser ────────────────────────────────────────────────── */

/**
 * Extract job blocks from the DE careers page.
 *
 * Each block matches:
 *   <h3 ... id="subtitle_DE:{id}:..." ...>{title}</h3>
 *   ...up to next <h3 id="subtitle_DE:...> or </section> boundary...
 *
 * We split the page at every `<h3 ... id="subtitle_DE:` opener and take the
 * subsequent slice as the block body. Heading-only sections (e.g. `id=95`
 * is "Jobs" page title, `id=179` is "Offene Stellen") are filtered:
 *   - we only keep blocks that have at least one accompanying `text1_DE:{id}`
 *     or `text2_DE:{id}` div (i.e. real vacancy markup).
 *   - we drop blocks whose title matches SPONTANEOUS_RE.
 */
export function parseCdsSavogninListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();

  // Find all subtitle headings with their position and id.
  const headRe = /<h3[^>]*\bid="subtitle_DE:(\d+):[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi;
  const heads = [];
  let hm;
  while ((hm = headRe.exec(html)) !== null) {
    heads.push({ start: hm.index, end: headRe.lastIndex, id: hm[1], titleRaw: hm[2] });
  }

  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const next = heads[i + 1];
    const blockHtml = html.slice(head.end, next ? next.start : Math.min(head.end + 8000, html.length));

    const text1Re = new RegExp(`<div[^>]*\\bid="text1_DE:${head.id}:[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
    const text2Re = new RegExp(`<div[^>]*\\bid="text2_DE:${head.id}:[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
    const text1 = blockHtml.match(text1Re);
    const text2 = blockHtml.match(text2Re);

    // Require at least one accompanying text block — heading-only sections
    // (page title, section header) lack these.
    if (!text1 && !text2) continue;

    const title = normalizeSpace(decodeEntities(String(head.titleRaw).replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    if (SPONTANEOUS_RE.test(title)) continue;
    if (seen.has(head.id)) continue;
    seen.add(head.id);

    const parts = [];
    if (text1) parts.push(htmlToText(text1[1]));
    if (text2) parts.push(htmlToText(text2[1]));

    // Optional PDF link inside the same block (extract first one).
    const pdfMatch = blockHtml.match(/<a[^>]*href="([^"]+\.pdf)"[^>]*>/i);
    const pdfUrl = pdfMatch
      ? (pdfMatch[1].startsWith('http') ? pdfMatch[1] : `https://cds-savognin.ch${pdfMatch[1].startsWith('/') ? '' : '/'}${pdfMatch[1]}`)
      : '';

    out.push({
      id: head.id,
      title,
      body: parts.filter(Boolean).join('\n\n'),
      pdfUrl,
    });
  }

  return out;
}

/* ── Description fallback ──────────────────────────────────── */

function buildFallbackDescription(title) {
  return [
    `${title} beim Center da Sanadad Savognin in Savognin, Kanton Graubünden.`,
    '',
    `Das Center da Sanadad Savognin (CDS) ist das regionale Gesundheitszentrum für Surses und Umgebung mit Akut-, Reha- und Pflegeabteilung. Wir bieten medizinische Grundversorgung in einem alpinen Umfeld und legen Wert auf ein kollegiales Team und individuelle Patientenbetreuung.`,
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllCdsSavogninJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${CDS_SAVOGNIN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (custom HTML, DE source)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch CDS Savognin career page: ${err?.message || err}`);
  }

  const listings = parseCdsSavogninListing(html);
  console.log(`  📋 Found ${listings.length} vacancies\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings parsed from CDS Savognin page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const listing of listings) {
    const title = listing.title;
    const url = `${PUBLIC_CAREER_URL}#subtitle_DE_${listing.id}`;

    let description = listing.body && listing.body.split(/\s+/).length >= 30
      ? listing.body
      : buildFallbackDescription(title);
    // Append a corporate-context footer for thinner postings — helps the AI
    // localisation step produce coherent translations.
    if (description.split(/\s+/).length < 80) {
      description = `${description}\n\n${buildFallbackDescription(title)}`;
    }

    const haystack = `${title} ${description}`;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${CDS_SAVOGNIN_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1').update(`${url}|${listing.id}`).digest('hex').slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(haystack);

    jobs.push({
      id: `${CDS_SAVOGNIN_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CDS_SAVOGNIN_COMPANY_NAME,
      companyKey: CDS_SAVOGNIN_KEY,
      companyDomain: CDS_SAVOGNIN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship source-locale-only; AI step clears this
      // flag once it fills the 3 remaining locales, otherwise the
      // translate-pending workflow picks them up.
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: inferSwissTargetCanton(DEFAULT_CITY) || DEFAULT_CANTON,
      url,
      source: 'CDS Savognin Dedicated Parser (custom HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: listing.pdfUrl || url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 65)} (${listing.id})`);
  }

  console.log(`\n📋 Total ${CDS_SAVOGNIN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
