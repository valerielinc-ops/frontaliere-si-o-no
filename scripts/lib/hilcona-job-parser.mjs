import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Hilcona AG (Bell Food Group) job parser.
 *
 * Source: https://career.bellfoodgroup.com
 * Strategy: fetch sitemap.job.xml → filter German /de/stelle/ URLs → fetch detail pages.
 *
 * The main listing page (/de/offene-stellen) is JS-rendered with no inline job data,
 * so we rely on the sitemap for discovery and individual job pages for details.
 */
import {
  stripScriptsAndStyles,
  stripHtml as stripHtmlKeepLines,
  normalizeDescriptionSpace,
} from './crawler-template.mjs';
import { extractMetaDescriptionRaw } from './meta-description-extract.mjs';
import { decode as decodeHTML } from 'html-entities';

const SITEMAP_URL = 'https://career.bellfoodgroup.com/sitemap.job.xml';
const CAREERS_BASE = 'https://career.bellfoodgroup.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

export function normalizeHilconaJobUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || '').trim(), CAREERS_BASE);
    const isJobPath = /^\/de\/stelle\/[^/]+-\d+\/?$/i.test(url.pathname);
    if (url.protocol !== 'https:' || url.origin !== CAREERS_BASE || url.username || url.password || !isJobPath) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

// ── shared utilities ──────────────────────────────────────────────────

export function stripHtml(html = '') {
  return decodeHTML(String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/g, ' ').trim();
}

export function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-'), 180);
}

export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

// ── sitemap parsing ───────────────────────────────────────────────────

/**
 * Parse Bell Food Group job sitemap XML.
 * Extracts all <loc> URLs and filters to German (/de/stelle/) to avoid duplicates.
 * Returns array of { id, jobId, title, url }.
 */
export function parseHilconaSitemapXml(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const seen = new Set();
  const jobs = [];

  // Extract all <loc> URLs from the sitemap
  const locPattern = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = locPattern.exec(xml)) !== null) {
    const url = normalizeHilconaJobUrl(m[1]);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Extract slug and numeric ID from URL: /de/stelle/{slug}-{numericId}
    const pathMatch = url.match(/\/de\/stelle\/(.+?)$/);
    if (!pathMatch) continue;
    const fullSlug = pathMatch[1];

    // The numeric ID is the last segment after the final hyphen
    const idMatch = fullSlug.match(/-(\d+)$/);
    const jobId = idMatch ? idMatch[1] : '';
    const slugPart = idMatch ? fullSlug.slice(0, idMatch.index) : fullSlug;

    // Prettify slug into a readable title (e.g. "lehrling-mechatronik-m-w-d" → "Lehrling Mechatronik M W D")
    const title = slugPart
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

    jobs.push({
      id: fullSlug,
      jobId,
      title,
      url,
    });
  }
  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

/** HTML fragment → text with one `• ` line per list item, entities decoded. */
function htmlToLines(html = '') {
  return normalizeDescriptionSpace(stripHtmlKeepLines(html))
    .replace(/•[ \t]*\n+[ \t]*/g, '• ')
    .replace(/\n{2,}(?=• )/g, '\n');
}

function oneLine(html = '') {
  return stripHtml(html).replace(/\s+/g, ' ').trim();
}

/**
 * Label/value facts rendered under the lead: `<div class="font-bold">Pensum</div>
 * <p …>100%</p>` (Vertragsart, Pensum, Arbeitszeitmodell, Stellenantritt, Sprache).
 * Read only between the lead and the benefits section, so no other bold label
 * of the page can leak in.
 */
export function parseHilconaJobFacts(html = '') {
  const page = String(html || '');
  const start = page.search(/<p\s+class="lead">/i);
  if (start < 0) return [];
  const end = page.indexOf('id="benefits"', start);
  const region = page.slice(start, end > start ? end : undefined);
  const facts = [];
  for (const match of region.matchAll(/<div class="font-bold">([^<]+)<\/div>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const label = oneLine(match[1]);
    const value = oneLine(match[2]);
    if (label && value) facts.push({ label, value });
  }
  return facts;
}

/**
 * "Das bieten wir" benefit cards: a bold title plus its `textbox-content` text.
 * Every card is in the server HTML; the "Mehr anzeigen" button only toggles
 * the visibility of the second half.
 */
export function parseHilconaBenefits(html = '') {
  const page = String(html || '');
  const start = page.indexOf('id="benefits"');
  if (start < 0) return [];
  const end = page.indexOf('id="task_experience"', start);
  const region = page.slice(start, end > start ? end : undefined);
  const benefits = [];
  for (const match of region.matchAll(/<div class="[^"]*\bfont-bold\b[^"]*">([^<]+)<\/div>\s*<div class="[^"]*\btextbox-content\b[^"]*">([\s\S]*?)<\/div>/gi)) {
    const title = oneLine(match[1]);
    const text = oneLine(match[2]);
    if (title && text) benefits.push({ title, text });
  }
  return benefits;
}

/**
 * Parse a Bell Food Group job detail page.
 * The portal uses a consistent HTML structure with:
 *   - <h1> for job title
 *   - <p class="lead"> for summary/intro
 *   - <meta name="description"> for meta description
 *   - Company name in <p class="... font-bold text-job-theme">
 *   - Address block after company name
 *   - Task/requirement sections under <h3 class="text-job-theme">
 *   - Contract type, pensum, language in labeled fields
 */
export function parseHilconaDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Title from <h1>
  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = h1Match ? stripHtml(h1Match[1]).trim() : '';

  // Lead paragraph (short description)
  const leadMatch = html.match(/<p\s+class="lead">([\s\S]*?)<\/p>/i);
  // Paragraphs between the lead and the facts block carry the application
  // conditions ("nur Bewerber … in der Schweiz arbeitsberechtigt (EU/EFTA)").
  const afterLead = leadMatch ? html.slice(leadMatch.index + leadMatch[0].length) : '';
  const beforeFacts = afterLead.slice(0, Math.max(0, afterLead.search(/<div\b/i)));
  const leadNotes = [...beforeFacts.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => oneLine(m[1])).filter(Boolean);
  const lead = leadMatch ? [oneLine(leadMatch[1]), ...leadNotes].filter(Boolean).join('\n\n') : '';

  // Meta description fallback
  const metaRaw = extractMetaDescriptionRaw(html);
  const metaDesc = metaRaw !== null ? stripHtml(metaRaw).trim() : '';

  // Company name: <p class="mb-0 font-bold text-job-theme">Company Name</p>
  const companyMatch = html.match(/<p[^>]*class="[^"]*font-bold text-job-theme[^"]*"[^>]*>([^<]+)<\/p>/i);
  const company = companyMatch ? stripHtml(companyMatch[1]).trim() : '';

  // Brand logo alt text as secondary company source
  const logoMatch = html.match(/<img[^>]+src="[^"]*brand-logos[^"]*"[^>]*alt="(?:Logo\s+)?([^"]+)"/i);
  const brandName = logoMatch ? stripHtml(logoMatch[1]).trim() : '';

  // Address: the <p class="mb-2 text-job-theme"> following the company name
  const addrMatch = html.match(/<p[^>]*class="[^"]*font-bold text-job-theme[^"]*"[^>]*>[^<]+<\/p>\s*<p[^>]*class="[^"]*mb-2 text-job-theme[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const addressRaw = addrMatch ? stripHtml(addrMatch[1]).trim() : '';

  // Contract type: after "Vertragsart" label
  const contractMatch = html.match(/Vertragsart<\/div>\s*<p[^>]*>([^<]+)<\/p>/i);
  const contractType = contractMatch ? stripHtml(contractMatch[1]).trim() : '';

  // Pensum (hours/percentage)
  const pensumMatch = html.match(/Pensum<\/div>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const pensum = pensumMatch ? stripHtml(pensumMatch[1]).trim() : '';

  // Language
  const langMatch = html.match(/Sprache<\/div>\s*<p[^>]*>([^<]+)<\/p>/i);
  const language = langMatch ? stripHtml(langMatch[1]).trim() : '';

  // Tasks section: <h3 class="text-job-theme">Deine Aufgaben</h3> followed by content
  const tasksMatch = html.match(/<h3[^>]*>Deine Aufgaben<\/h3>\s*([\s\S]*?)(?:<\/div>)/i);
  const tasksHtml = tasksMatch ? tasksMatch[1] : '';

  // Requirements section: <h3 class="text-job-theme">Das bringst du mit</h3>
  const reqMatch = html.match(/<h3[^>]*>Das bringst du mit<\/h3>\s*([\s\S]*?)(?:<\/div>)/i);
  const reqHtml = reqMatch ? reqMatch[1] : '';

  // The ad is more than lead + tasks + profile (#5253): the job facts under the
  // lead (contract, workload, working-time model, start date, workplace,
  // language) and the "Das bieten wir" benefit cards are part of it — they were
  // dropped, so the published text carried about a third of the vacancy.
  const facts = parseHilconaJobFacts(html);
  const workplace = [company, addressRaw.replace(/\s*\n\s*/g, ', ')].filter(Boolean).join(', ');
  const benefits = parseHilconaBenefits(html);

  const parts = [];
  if (lead) parts.push(lead);
  const factLines = facts.map(({ label, value }) => `• ${label}: ${value}`);
  if (workplace) factLines.push(`• Arbeitsort: ${workplace}`);
  if (factLines.length) parts.push(factLines.join('\n'));
  const tasksText = htmlToLines(tasksHtml);
  if (tasksText) parts.push(`Aufgaben:\n${tasksText}`);
  const reqText = htmlToLines(reqHtml);
  if (reqText) parts.push(`Anforderungen:\n${reqText}`);
  if (benefits.length) {
    parts.push(`Das bieten wir:\n${benefits.map(({ title: name, text }) => `• ${name}: ${text}`).join('\n')}`);
  }

  // Fallback: use meta description if parts are too short
  let description = parts.join('\n\n').trim();
  if (description.length < 30 && metaDesc) description = metaDesc;

  // Extract source-backed geography from the address and the portal's own
  // Google Maps route. The sitemap spans several countries; a four-digit
  // postal code alone is not Swiss evidence (Liechtenstein uses it too).
  let location = '';
  let postalCode = '';
  if (addressRaw) {
    // Address format: "Hauptstrasse 80 5223 Pfaffstätt" or "Landquart"
    const postalCityMatch = addressRaw.match(/(\d{4,5})\s+(\S+(?:\s+\S+)?)/);
    postalCode = postalCityMatch ? postalCityMatch[1] : '';
    location = postalCityMatch ? postalCityMatch[2] : addressRaw.split('\n').pop().trim();
  }
  const mapRouteMatch = html.match(/google\.com\/maps\/dir\/\/([^"']+?)(?:\/@|["'])/i);
  const mapRoute = mapRouteMatch
    ? decodeURIComponent(mapRouteMatch[1]).replace(/\+/g, ' ')
    : '';
  const addressCountry = /\b(?:Schweiz|Switzerland|Suisse|Svizzera)\b/i.test(mapRoute)
    ? 'CH'
    : /\bLiechtenstein\b/i.test(mapRoute)
      ? 'LI'
      : /\bDeutschland\b/i.test(mapRoute)
        ? 'DE'
        : /\bÖsterreich\b/i.test(mapRoute)
          ? 'AT'
          : '';

  if (!description || description.length < 30) return null;

  return {
    title,
    description,
    company: company || brandName || '',
    location,
    postalCode,
    addressCountry,
    contractType,
    pensum,
    language,
  };
}

// ── fetch helpers ─────────────────────────────────────────────────────

/**
 * Fetch all job URLs from the Bell Food Group job sitemap.
 * Returns parsed German job entries.
 */
export async function fetchHilconaJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(SITEMAP_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseHilconaSitemapXml(xml);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Bell Food Group job sitemap: ${err.message}`);
    // A fetch failure is not an empty listing: let the crawler pipeline
    // classify it (connection-level soft exit or HTTP error) instead of
    // publishing a cause-less no-jobs-parsed abort.
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Bell Food Group job detail page.
 */
export async function fetchHilconaDetailPage(url, timeoutMs = 15000) {
  const safeUrl = normalizeHilconaJobUrl(url);
  if (!safeUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(safeUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseHilconaDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
