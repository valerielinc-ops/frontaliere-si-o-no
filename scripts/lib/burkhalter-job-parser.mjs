/**
 * Burkhalter Group detail-page parser.
 *
 * Every vacancy page on burkhalter.ch embeds a schema.org `JobPosting` whose
 * `description` is exactly the role: company intro, "Deine Aufgaben",
 * "Dein Profil", "Deine Vorteile" as `<h3>` + `<ul>` blocks, and the closing
 * "how to apply" paragraph. It is the primary source here. The visible
 * `<div class="content">` markup is the fallback only: it opens with the
 * breadcrumb ("• Vacancies • <title>"), repeats the title and workload, and
 * closes with the contact card (name, street, phone, e-mail, website), none
 * of which is posting content.
 */

import { extractDetailFields } from './prospector/extract.mjs';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
};

function decodeEntities(value = '') {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : entity;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? entity : named;
  });
}

/**
 * Posting HTML as markdown: `<h1-6>` → `## `, `<li>` → `- `, paragraphs kept
 * apart, `<br>` as a line break, list items kept on consecutive lines.
 */
export function burkhalterHtmlToMarkdown(html = '') {
  const text = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, heading) => `\n\n## ${heading}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol|section|blockquote)(?:\s[^>]*)?>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim());
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '-' || line === '##') continue;
    if (!line) {
      const prev = out[out.length - 1] || '';
      const next = lines.slice(i + 1).find((candidate) => candidate && candidate !== '-') || '';
      if (prev.startsWith('- ') && next.startsWith('- ')) continue;
      if (prev !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function jobPostingNodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(jobPostingNodes);
  const nodes = [];
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) nodes.push(value);
  if (Array.isArray(value['@graph'])) nodes.push(...jobPostingNodes(value['@graph']));
  return nodes;
}

/** The `JobPosting.description` of the page as markdown, or ''. */
export function extractBurkhalterJsonLdDescription(html = '') {
  const scripts = String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    for (const posting of jobPostingNodes(data)) {
      const markdown = burkhalterHtmlToMarkdown(posting.description || '');
      if (markdown) return markdown;
    }
  }
  return '';
}

/**
 * Legacy extraction from the visible content block, kept as the fallback for
 * a page without a usable JSON-LD description.
 */
export function extractBurkhalterContentDescription(html = '') {
  const contentMatch = String(html || '').match(/<div class="content">([\s\S]*?)<footer/i)
    || String(html || '').match(/<div data-addsearch="include">([\s\S]*?)<footer/i);
  if (!contentMatch) return '';

  const text = contentMatch[1]
    // Strip script/style content entirely — tag-only stripping below leaves JSON-LD
    // payload visible as raw text.
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Remove breadcrumb and header noise
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const contentStart = lines.findIndex((l) =>
    l.includes('Ihr Profil') || l.includes('Your Profile') ||
    l.includes('Votre profil') || l.includes('Il tuo profilo') ||
    l.includes('Unser Angebot') || l.includes('suchen wir') ||
    l.includes('looking for') || l.includes('recherchons') ||
    lines.indexOf(l) > 3
  );
  const relevantLines = contentStart > 0 ? lines.slice(Math.max(0, contentStart - 2)) : lines.slice(3);
  return relevantLines.join('\n').trim();
}

/**
 * Description of one detail page: JSON-LD first, visible content second.
 * Never truncated: a character cap cuts the tail of the posting (benefits,
 * contact), which is exactly the incomplete-description class issue 5253
 * measures; the extraction is already bounded to the vacancy content.
 */
export function extractBurkhalterDetailDescription(html = '') {
  const description = extractBurkhalterJsonLdDescription(html) || extractBurkhalterContentDescription(html);
  return description.trim();
}

/**
 * Extract the source workplace together with the source-only description.
 * Burkhalter's JobPosting JSON-LD carries the real branch address; keeping it
 * lets the quality audit distinguish two same-role postings at different
 * Davos sites instead of treating their shared city as the workplace key.
 */
export function extractBurkhalterDetailFields(html = '', pageUrl = '') {
  let detail = {};
  try {
    detail = extractDetailFields(html, pageUrl) || {};
  } catch {
    // A malformed auxiliary block must not discard the valid JobPosting body.
  }
  const candidates = Array.isArray(detail.locationCandidates) ? detail.locationCandidates : [];
  const candidate = candidates.find((entry) => entry?.postalCode && entry?.streetAddress)
    || candidates.find((entry) => entry?.addressLocality || entry?.postalCode || entry?.streetAddress)
    || {};
  return {
    description: extractBurkhalterDetailDescription(html),
    addressLocality: String(candidate.addressLocality || candidate.location || '').trim(),
    postalCode: String(candidate.postalCode || '').trim(),
    streetAddress: String(candidate.streetAddress || '').trim(),
  };
}

/**
 * A stub, not a posting: the `<title> presso <company>, <city>` line earlier
 * runs published when a detail page could not be read, and its machine
 * translations ("Description <title> at <company>, <city>", "Beschreibung …
 * bei …"). A Burkhalter posting read from the source is always a multi-line
 * text (JSON-LD sections); a single line under 300 characters never is.
 */
export function isBurkhalterStubText(text = '') {
  const value = String(text || '').trim();
  return value.length > 0 && value.length < 300 && !/\n/.test(value);
}

/**
 * The source text a stored record carries (source-locale slot first, then
 * the top-level description), or null when it only has stubs.
 */
export function storedBurkhalterSourceText(record) {
  if (!record) return null;
  const lang = String(record.sourceLang || '').trim();
  for (const candidate of [record.descriptionByLocale?.[lang], record.description]) {
    const text = String(candidate || '').trim();
    if (text && !isBurkhalterStubText(text)) return { text, lang };
  }
  return null;
}

/**
 * Merge one discovered job into its stored record under the source-only rule:
 *   - body read this run → it becomes the description and source-locale slot;
 *   - no body → keep the text a previous run read from the source;
 *   - no body and nothing stored → `null`: the job is not published this run.
 * Stub texts left in any locale slot are removed so the translation step
 * refills them from the real source text.
 *
 * @param {object|null} prev stored record (null for a new job)
 * @param {object} job discovered job; `description` is '' when the page was not read
 * @param {(prev: object, next: object) => object} mergeLocales merges the locale maps (runner-provided)
 * @returns {object|null}
 */
export function mergeBurkhalterRecord(prev, job, mergeLocales = (p, n) => ({
  ...p,
  ...n,
  descriptionByLocale: { ...(p.descriptionByLocale || {}), ...(n.descriptionByLocale || {}) },
})) {
  let next = job;
  if (!String(job.description || '').trim()) {
    const stored = storedBurkhalterSourceText(prev);
    if (!stored) return null;
    next = {
      ...job,
      description: stored.text,
      sourceLang: stored.lang || job.sourceLang,
      descriptionByLocale: stored.lang ? { [stored.lang]: stored.text } : {},
    };
  }
  const merged = prev ? mergeLocales(prev, next) : { ...next };
  // A transient detail-page miss must not erase a workplace address read on a
  // previous source fetch. A newly read non-empty field still replaces it.
  for (const field of ['postalCode', 'streetAddress']) {
    if (!String(merged[field] || '').trim() && String(prev?.[field] || '').trim()) {
      merged[field] = prev[field];
    }
  }
  const byLocale = { ...(merged.descriptionByLocale || {}) };
  for (const [locale, text] of Object.entries(byLocale)) {
    if (isBurkhalterStubText(text)) delete byLocale[locale];
  }
  merged.descriptionByLocale = byLocale;
  if (isBurkhalterStubText(merged.description)) {
    const source = storedBurkhalterSourceText(merged);
    if (!source) return null;
    merged.description = source.text;
  }
  return merged;
}
