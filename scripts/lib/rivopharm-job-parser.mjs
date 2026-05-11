/**
 * Rivopharm SA — custom HTML job listing parser
 *
 * Rivopharm SA is a Swiss pharmaceutical company headquartered in Manno, Canton Ticino.
 * They specialize in generic pharmaceuticals with a focus on psychiatric,
 * antidepressant, anti-inflammatory, epilepsy, and diabetes medications.
 *
 * Career page: https://rivopharm.com/careers
 * The page is rendered server-side; we parse HTML directly.
 */

export const MIN_DESC_LENGTH = 80;

/**
 * Normalize whitespace in a string.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode common entities.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '\u201c')
    .replace(/&#8221;/g, '\u201d')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slugify a text string for URL usage.
 */
export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

/**
 * Parse job listings from Rivopharm careers HTML.
 *
 * The Rivopharm careers page may list jobs in various HTML structures:
 * - Individual job cards/sections
 * - A list/table of positions
 * - Accordion-style expandable sections
 *
 * This parser handles common patterns and extracts title, description, and location.
 *
 * @param {string} html - Raw HTML of the careers page
 * @returns {Array<{title: string, descriptionText: string, location: string, url: string, idx: number}>}
 */
export function parseRivopharmJobs(html = '') {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  let idx = 0;

  // Strategy 1: Look for structured job cards with headings (h2/h3/h4) + description
  // Common in WordPress/custom CMS sites
  const jobBlockRe = /<(?:article|div|section)[^>]*class="[^"]*(?:job|position|vacancy|opening|career)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|section)>/gi;
  let blockMatch;
  while ((blockMatch = jobBlockRe.exec(html)) !== null) {
    const block = blockMatch[1];
    const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
    if (!titleMatch) continue;

    const title = normalizeSpace(htmlToText(titleMatch[1]));
    if (!title || title.length < 3) continue;

    const descriptionText = normalizeSpace(htmlToText(block));
    if (descriptionText.length < MIN_DESC_LENGTH) continue;

    const linkMatch = block.match(/href="([^"]+)"/i);
    const url = linkMatch ? linkMatch[1] : '';

    idx++;
    jobs.push({ title, descriptionText, location: 'Manno', url, idx });
  }

  // Strategy 2: Look for list-based job entries (e.g., <li> with links)
  if (jobs.length === 0) {
    const listItemRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = listItemRe.exec(html)) !== null) {
      const item = liMatch[1];
      const linkMatch = item.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const title = normalizeSpace(htmlToText(linkMatch[2]));
      if (!title || title.length < 5) continue;
      if (!/\b(?:position|role|manager|engineer|specialist|analyst|operator|technician|scientist|director|coordinator|assistant|intern|stage|lead)/i.test(title)) continue;

      const descriptionText = normalizeSpace(htmlToText(item));
      const url = linkMatch[1];

      idx++;
      jobs.push({
        title,
        descriptionText: descriptionText.length >= MIN_DESC_LENGTH ? descriptionText : `${title} position at Rivopharm SA in Manno, Canton Ticino, Switzerland. Rivopharm is a leading Swiss pharmaceutical company specializing in generic medications.`,
        location: 'Manno',
        url,
        idx,
      });
    }
  }

  // Strategy 3: Look for headings that look like job titles followed by content
  if (jobs.length === 0) {
    const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
    const headings = [];
    let hMatch;
    while ((hMatch = headingRe.exec(html)) !== null) {
      headings.push({ text: normalizeSpace(htmlToText(hMatch[1])), index: hMatch.index, end: headingRe.lastIndex });
    }

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (!/\b(?:position|role|manager|engineer|specialist|analyst|operator|technician|scientist|director|coordinator|assistant|intern|stage|lead|apprenti)/i.test(h.text)) continue;

      const nextStart = i + 1 < headings.length ? headings[i + 1].index : html.length;
      const contentBlock = html.slice(h.end, nextStart);
      const descriptionText = normalizeSpace(htmlToText(contentBlock));
      if (descriptionText.length < MIN_DESC_LENGTH) continue;

      idx++;
      jobs.push({ title: h.text, descriptionText, location: 'Manno', url: '', idx });
    }
  }

  return jobs;
}
