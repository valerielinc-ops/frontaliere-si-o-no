/**
 * Hilcona AG (Bell Food Group) job parser.
 *
 * Source: https://career.bellfoodgroup.com
 * Strategy: fetch sitemap.job.xml → filter German /de/stelle/ URLs → fetch detail pages.
 *
 * The main listing page (/de/offene-stellen) is JS-rendered with no inline job data,
 * so we rely on the sitemap for discovery and individual job pages for details.
 */

const SITEMAP_URL = 'https://career.bellfoodgroup.com/sitemap.job.xml';
const CAREERS_BASE = 'https://career.bellfoodgroup.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// ── shared utilities ──────────────────────────────────────────────────

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ').trim();
}

export function slugify(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 180);
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
    const url = m[1].trim();
    // Only keep German (/de/stelle/) URLs to get one entry per job
    if (!url.includes('/de/stelle/')) continue;
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
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = h1Match ? stripHtml(h1Match[1]).trim() : '';

  // Lead paragraph (short description)
  const leadMatch = html.match(/<p\s+class="lead">([\s\S]*?)<\/p>/i);
  const lead = leadMatch ? stripHtml(leadMatch[1]).trim() : '';

  // Meta description fallback
  const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)">/i);
  const metaDesc = metaDescMatch ? stripHtml(metaDescMatch[1]).trim() : '';

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

  // Build description from lead + tasks + requirements
  const parts = [];
  if (lead) parts.push(lead);
  const tasksText = stripHtml(tasksHtml).trim();
  if (tasksText) parts.push(`Aufgaben: ${tasksText}`);
  const reqText = stripHtml(reqHtml).trim();
  if (reqText) parts.push(`Anforderungen: ${reqText}`);

  // Fallback: use meta description if parts are too short
  let description = parts.join(' ').trim();
  if (description.length < 30 && metaDesc) description = metaDesc;

  // Extract location from address (postal code + city)
  let location = '';
  if (addressRaw) {
    // Address format: "Hauptstrasse 80 5223 Pfaffstätt" or "Landquart"
    const postalCityMatch = addressRaw.match(/(\d{4,5})\s+(\S+(?:\s+\S+)?)/);
    location = postalCityMatch ? postalCityMatch[2] : addressRaw.split('\n').pop().trim();
  }

  if (!description || description.length < 30) return null;

  return {
    title,
    description,
    company: company || brandName || '',
    location,
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
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseHilconaSitemapXml(xml);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Bell Food Group job sitemap: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Bell Food Group job detail page.
 */
export async function fetchHilconaDetailPage(url, timeoutMs = 15000) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
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
