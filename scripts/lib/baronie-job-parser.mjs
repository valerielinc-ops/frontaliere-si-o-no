import { decode as decodeHTML } from 'html-entities';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { normalizeSpace, normalizeDescriptionSpace, stripScriptsAndStyles } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/**
 * Baronie (Chocolat Alprose SA) — detail page parser
 *
 * Detail pages at https://www.baronie.com/en/jobs/{slug}
 *
 * HTML structure:
 *   <article class="s-entry__content s-text-markup">
 *     <h1 class="s-text-medium-large">TITLE</h1>
 *     <p class="s-text-medium"><p>INTRO</p></p>
 *     <div class="s-text-markup">
 *       <p>PREAMBLE</p>
 *       <h3>Section heading</h3>
 *       <ul><li>Item 1</li>...</ul>
 *       ...
 *     </div>
 *   </article>
 *
 * Sections to skip: "Interested?", "About Baronie", "Apply now/today"
 *
 * JSON-LD JobPosting may also be present with hiringOrganization,
 * jobLocation, etc.
 */

const CAREERS_URL = 'https://www.baronie.com/en/careers';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';


function stripHtml(html = '') {
  return decodeHTML(String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * Word-level overlap between two strings (0..1).
 */
export function titleOverlap(a, b) {
  if (!a || !b) return 0;
  const clean = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
  const wordsA = new Set(clean(a));
  const wordsB = new Set(clean(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.max(wordsA.size, wordsB.size);
}

// Content section headings to extract
const CONTENT_HEADINGS = /responsibilities|tasks|role|profil|skills|expertise|requirements|offer|we offer|what you bring|qualifications|your key|jouw|wie ben|praktisch|aufgaben|anforderungen|wir bieten|vos missions|votre profil|mansioni|requisiti|offriamo/i;

// Headings to skip
const SKIP_HEADINGS = /interested\?|about baronie|apply now|apply today|send.*cv|über baronie|à propos/i;

/**
 * Extract list items from a chunk of HTML.
 */
function extractListItems(html) {
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(m[1]));
    if (text.length > 2) items.push(text);
  }
  return items;
}

/**
 * Extract paragraphs from HTML (non-empty <p> tags).
 */
function extractParagraphs(html) {
  const paras = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(m[1]));
    if (text.length > 10) paras.push(text);
  }
  return paras;
}

/**
 * Parse a Baronie detail page HTML into structured content.
 * Returns { detailTitle, introText, sections[], markdown, sectionCount, location, company, sourceTextLength }
 */
export function parseBaronieDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title from h1 inside article
  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*class="[^"]*s-text-medium-large[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const detailTitle = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';

  // Extract intro text from <p class="s-text-medium">
  const introMatch = html.match(/<p[^>]*class="[^"]*s-text-medium[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const introText = introMatch ? normalizeDescriptionSpace(stripHtml(introMatch[1])) : '';

  // Extract the main body div: <div class="s-text-markup"> inside article
  // There are multiple s-text-markup divs; we want the one inside the article
  const articleMatch = html.match(/<article[^>]*class="[^"]*s-entry__content[^"]*"[^>]*>([\s\S]*?)<\/article>/i);
  const articleHtml = articleMatch ? articleMatch[1] : '';

  // Within the article, find the s-text-markup div (the body content, not the intro)
  const bodyMatch = articleHtml.match(/<div[^>]*class="[^"]*s-text-markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/si)
    || articleHtml.match(/<div[^>]*class="[^"]*s-text-markup[^"]*"[^>]*>([\s\S]*)/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : '';

  // Parse h3 sections from the body
  const sections = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const h3Matches = [];
  let m;
  while ((m = h3Re.exec(bodyHtml)) !== null) {
    h3Matches.push({ heading: normalizeSpace(stripHtml(m[1])), index: m.index, length: m[0].length });
  }

  // Extract preamble text before first h3 (if any)
  let preambleText = '';
  if (h3Matches.length > 0) {
    const preHtml = bodyHtml.slice(0, h3Matches[0].index);
    const preParagraphs = extractParagraphs(preHtml);
    preambleText = preParagraphs.join(' ');
  } else if (bodyHtml) {
    // No h3 sections — use entire body as text
    preambleText = stripHtml(bodyHtml);
  }

  for (let i = 0; i < h3Matches.length; i++) {
    const { heading, index, length } = h3Matches[i];
    if (SKIP_HEADINGS.test(heading)) continue;

    const start = index + length;
    const end = i + 1 < h3Matches.length ? h3Matches[i + 1].index : bodyHtml.length;
    const sectionHtml = bodyHtml.slice(start, end);

    const items = extractListItems(sectionHtml);
    const paragraphs = extractParagraphs(sectionHtml);

    if (items.length > 0 || paragraphs.length > 0) {
      sections.push({
        heading: normalizeSpace(heading.replace(/:$/, '')),
        items,
        paragraphs: items.length === 0 ? paragraphs : [],
      });
    }
  }

  // Build markdown
  const parts = [];
  if (introText) parts.push(introText);
  if (preambleText && preambleText !== introText) parts.push(preambleText);
  for (const sec of sections) {
    if (sec.items.length > 0) {
      parts.push(`\n## ${sec.heading}\n${sec.items.map((it) => `- ${it}`).join('\n')}`);
    } else if (sec.paragraphs.length > 0) {
      parts.push(`\n## ${sec.heading}\n${sec.paragraphs.join('\n')}`);
    }
  }
  const markdown = parts.join('\n').trim();

  // Extract JSON-LD for location and company info
  let location = '';
  let company = '';
  let addressCountry = '';
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      const candidates = Array.isArray(ld) ? ld : Array.isArray(ld?.['@graph']) ? ld['@graph'] : [ld];
      const job = candidates.find((node) => node && node['@type'] === 'JobPosting') || null;
      if (job) {
        const jobLocations = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
        const jobLocation = jobLocations.find((loc) => /^CH$/i.test(loc?.address?.addressCountry || '')) || jobLocations[0];
        if (jobLocation?.address) {
          const addr = jobLocation.address;
          location = normalizeSpace(addr.addressLocality || '');
          addressCountry = normalizeSpace(addr.addressCountry || '');
        }
        if (job.hiringOrganization?.name) {
          company = normalizeSpace(job.hiringOrganization.name);
        }
      }
    } catch { /* ignore JSON parse errors */ }
  }

  // Fallback location detection from text
  if (!location) {
    const locMatch = html.match(/(?:Caslano|Lugano|Locarno|Bellinzona|Chiasso|Mendrisio|Giubiasco)/i);
    if (locMatch) location = locMatch[0];
  }

  const sourceTextLength = stripHtml(articleHtml).length;

  return {
    detailTitle,
    introText,
    preambleText,
    sections,
    markdown,
    sectionCount: sections.length,
    location,
    addressCountry,
    company,
    sourceTextLength,
  };
}

/**
 * Check if a Baronie job is actually in Switzerland (Ticino).
 */
export function isSwissJob(parsed) {
  if (!parsed) return false;
  // JSON-LD addressCountry is the most reliable signal
  if (parsed.addressCountry) {
    return /^CH$/i.test(parsed.addressCountry) || /switzerland/i.test(parsed.addressCountry);
  }
  // Fallback: check location text for target Swiss locations
  if (parsed.location) {
    return isTargetSwissLocation(parsed.location);
  }
  return false;
}

/**
 * Fetch all job detail URLs from the Baronie careers page.
 */
export async function fetchBaronieJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const urls = new Set();
    const hrefPattern = /href="((?:https?:\/\/www\.baronie\.com)?\/en\/jobs\/[^"]+)"/g;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      const href = match[1];
      const fullUrl = href.startsWith('http') ? href : `https://www.baronie.com${href}`;
      urls.add(fullUrl);
    }
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Baronie detail page.
 */
export async function fetchBaronieDetailPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseBaronieDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build localized content for a Baronie job from parsed detail data.
 *
 * The description is the detail text only, in the slot of its own language
 * (`sourceLang`, detected by the runner) — issue 5253. The builder used to
 * key it as `it` whatever its language, and to replace a text of 100
 * characters or less with "<company>, azienda svizzera del gruppo Baronie
 * specializzata nella produzione di cioccolato premium, cerca un profilo
 * <title>…", a paragraph we wrote. A posting without text, or under the
 * shared 50-word floor, now gets no description and takes the thin-source
 * path of the pipeline.
 */
export function buildBaronieLocalizedContent({ title, location, detailMarkdown, sourceLang }) {
  const city = normalizeSpace(location) || 'Caslano';
  const text = String(detailMarkdown || '').trim();
  const description = meetsSourceBodyFloor(text) ? text : '';
  const lang = String(sourceLang || '').trim() || 'en';

  return {
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: description ? { [lang]: description } : {},
    slugByLocale: {
      it: slugify(`${title} baronie ${city}`),
      en: slugify(`${title} baronie ${city}`),
      de: slugify(`${title} baronie ${city}`),
      fr: slugify(`${title} baronie ${city}`),
    },
  };
}
