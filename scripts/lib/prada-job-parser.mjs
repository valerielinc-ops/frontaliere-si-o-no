/**
 * Prada Group — jobs.pradagroup.com job parser
 *
 * Prada Group operates luxury fashion brands with a major site in Mendrisio, Ticino.
 * The careers portal uses SAP SuccessFactors at:
 *   https://jobs.pradagroup.com/
 *
 * Search endpoint:
 *   https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location
 *
 * Job detail URLs follow the pattern:
 *   https://jobs.pradagroup.com/job/{Location}-{Title}/{jobId}/
 *
 * HTML structure on the search results page:
 *   <table class="searchResults">
 *     <tr class="data-row">
 *       <td class="jobTitle ..."><a/span class="jobTitle-link" href="/job/.../{id}/">Title</a/span></td>
 *       <td class="colLocation ...">Location</td>
 *     </tr>
 *   </table>
 */

const SEARCH_URL = 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location';
const TICINO_SEARCH_URL = 'https://jobs.pradagroup.com/search/?q=&locationsearch=ticino&searchby=location';
const CAREERS_BASE = 'https://jobs.pradagroup.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Parse the Prada Group SuccessFactors search results page HTML.
 * Extracts job listings from <table class="searchResults"> with data-row entries.
 *
 * Real HTML structure:
 *   <tr class="data-row">
 *     <td class="jobTitle hidden-phone">
 *       <a/span class="jobTitle-link" href="/job/{path}/{jobId}/">Title</a/span>
 *     </td>
 *     <td class="colLocation hidden-phone">Location</td>
 *   </tr>
 *
 * SuccessFactors renders both desktop and mobile versions — deduplicate by jobId.
 *
 * @returns {Array<{id: string, title: string, url: string, location: string, canton: string, department: string, jobId: string}>}
 */
export function parsePradaListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: SuccessFactors jobTitle-link with href — <a class="jobTitle-link" href="/job/.../{id}/">
  const linkRe = /<(?:a|span)[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*href="([^"]*\/job\/([^"]*?)\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/(?:a|span)>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const relUrl = match[1];
    const jobId = match[3];
    const rawTitle = normalizeSpace(stripHtml(match[4]));
    if (!rawTitle || rawTitle.length < 3 || seen.has(jobId)) continue;
    seen.add(jobId);

    const fullUrl = relUrl.startsWith('http') ? relUrl : `${CAREERS_BASE}${relUrl}`;

    // Extract location from the next colLocation cell
    const afterMatch = html.slice(match.index, match.index + 1000);
    const locMatch = afterMatch.match(/class="[^"]*colLocation[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const location = locMatch ? normalizeSpace(stripHtml(locMatch[1])) : '';

    // Extract department from colDepartment cell if present
    const deptMatch = afterMatch.match(/class="[^"]*colDepartment[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const department = deptMatch ? normalizeSpace(stripHtml(deptMatch[1])) : '';

    jobs.push({
      id: `prada-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      location: location || 'Mendrisio',
      canton: 'TI',
      department,
      jobId,
    });
  }

  // Pattern 2: href="/job/.../{id}/" links without jobTitle-link class (fallback)
  if (jobs.length === 0) {
    const fallbackRe = /<a\s+[^>]*href="(\/job\/[^"]*?\/(\d{5,})\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
    let fMatch;
    while ((fMatch = fallbackRe.exec(html)) !== null) {
      const relUrl = fMatch[1];
      const jobId = fMatch[2];
      const rawTitle = normalizeSpace(stripHtml(fMatch[3]));
      if (!rawTitle || rawTitle.length < 3 || seen.has(jobId)) continue;
      seen.add(jobId);

      jobs.push({
        id: `prada-${jobId}`,
        title: rawTitle,
        url: `${CAREERS_BASE}${relUrl}`,
        location: 'Mendrisio',
        canton: 'TI',
        department: '',
        jobId,
      });
    }
  }

  return jobs;
}

/**
 * Parse a Prada Group SuccessFactors job detail page for description content.
 * SuccessFactors detail pages use class patterns like:
 *   - jobdetail-container, jobdetail-externalDescription
 *   - job-description, requisitionDescription
 *
 * Also extracts title and location if present in the detail HTML.
 */
export function parsePradaDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let rawHtml = '';

  // SuccessFactors-specific selectors (priority order)
  const selectors = [
    /<div[^>]*class="[^"]*jobdetail-externalDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*jobdetail-container[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*requisitionDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*job[-_]?description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*job[-_]?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<section[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
  ];

  // Prada uses <span class="jobdescription"> with nested <span> tags inside.
  // Regex can't handle nesting, so extract with depth tracking first.
  const spanClassIdx = html.indexOf('class="jobdescription"');
  if (spanClassIdx > 0) {
    const tagStart = html.lastIndexOf('<', spanClassIdx);
    const tagMatch = html.slice(tagStart).match(/^<(span|div)[^>]*>/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      const contentStart = tagStart + tagMatch[0].length;
      let depth = 1, pos = contentStart;
      const openRe = new RegExp(`<${tag}[\\s>]`, 'gi');
      const closeRe = new RegExp(`</${tag}>`, 'gi');
      while (depth > 0 && pos < html.length) {
        openRe.lastIndex = pos;
        closeRe.lastIndex = pos;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);
        if (!nextClose) break;
        if (nextOpen && nextOpen.index < nextClose.index) {
          depth++;
          pos = nextOpen.index + nextOpen[0].length;
        } else {
          depth--;
          if (depth === 0) {
            rawHtml = html.slice(contentStart, nextClose.index);
            break;
          }
          pos = nextClose.index + nextClose[0].length;
        }
      }
    }
  }

  if (!rawHtml) {
    for (const re of selectors) {
      const m = html.match(re);
      if (m && m[1] && m[1].length > 50) {
        rawHtml = m[1];
        break;
      }
    }
  }

  if (!rawHtml) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) rawHtml = mainMatch[1];
  }

  let description = stripHtml(rawHtml);

  // SuccessFactors detail pages are often 100% JS-rendered.
  // Fallback to og:description or meta description which ARE server-rendered.
  if (!description || description.length < 30) {
    const ogDescMatch = html.match(/<meta\s+property="[^"]*og:description[^"]*"\s+content="([^"]*)"/i)
      || html.match(/<meta\s+content="([^"]*)"\s+property="[^"]*og:description[^"]*"/i);
    if (ogDescMatch) description = normalizeSpace(ogDescMatch[1]);
  }
  if (!description || description.length < 30) {
    const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    if (metaDescMatch) description = normalizeSpace(metaDescMatch[1]);
  }

  // Extract title from the detail page
  const titleMatch = html.match(/<h1[^>]*class="[^"]*jobTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract location from the detail page
  const locMatch = html.match(/class="[^"]*jobdetail-location[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td|p)>/i)
    || html.match(/class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td|p)>/i);
  const location = locMatch ? normalizeSpace(stripHtml(locMatch[1])) : '';

  // Extract department
  const deptMatch = html.match(/class="[^"]*jobdetail-department[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td|p)>/i)
    || html.match(/class="[^"]*job-department[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td|p)>/i);
  const department = deptMatch ? normalizeSpace(stripHtml(deptMatch[1])) : '';

  return {
    description: description || '',
    rawHtml,
    title,
    location,
    department,
  };
}

/**
 * Fetch all job URLs from the Prada Group SuccessFactors search endpoint.
 * Searches for both "switzerland" and "ticino" to maximize coverage.
 */
export async function fetchPradaJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const allJobs = [];
    const seenIds = new Set();

    for (const searchUrl of [SEARCH_URL, TICINO_SEARCH_URL]) {
      const res = await fetch(searchUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();
      const jobs = parsePradaListingHtml(html);
      for (const job of jobs) {
        if (!seenIds.has(job.jobId)) {
          seenIds.add(job.jobId);
          allJobs.push(job);
        }
      }
    }

    clearTimeout(timer);
    return allJobs;
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Prada Group careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Prada Group detail page.
 */
export async function fetchPradaDetailPage(url, timeoutMs = 15000) {
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
    return parsePradaDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
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
