/**
 * ReleWant — Zoho Recruit career page parser
 *
 * API: https://relewant.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers
 * Returns JSON with job listings including title, city, country, type, id, and detail URL.
 *
 * Detail page: https://relewant.zohorecruit.com/jobs/Careers/{id}/{title}
 * Contains embedded JSON with full job data including Job_Description HTML.
 *
 * Detail URL pattern: https://relewant.zohorecruit.com/jobs/Careers/{id}/{title}?source=CareerSite
 * Apply URL pattern:  https://relewant.zohorecruit.com/jobs/Careers/{id}/{title}/apply?source=CareerSite
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const API_URL = 'https://relewant.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

// ─────────────────────────────────────────────────────────────
// Title overlap guard
// ─────────────────────────────────────────────────────────────

function normWords(s = '') {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function titleOverlap(expected = '', actual = '') {
  const expWords = normWords(expected);
  const actWords = new Set(normWords(actual));
  if (expWords.length === 0) return 1;
  const matches = expWords.filter((w) => actWords.has(w)).length;
  return matches / expWords.length;
}

// ─────────────────────────────────────────────────────────────
// HTML → Markdown converter for Zoho Recruit descriptions
// ─────────────────────────────────────────────────────────────

export function zohoHtmlToMarkdown(html = '') {
  if (!html || !html.trim()) return '';

  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  if (!root) return '';

  const lines = [];

  function processElement(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toLowerCase();

      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        const text = normalizeSpace(child.textContent);
        if (text) {
          const prefix = tag === 'h1' ? '## ' : tag === 'h2' ? '### ' : '#### ';
          lines.push('', prefix + text);
        }
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        const items = child.querySelectorAll(':scope > li');
        for (const li of items) {
          const text = normalizeSpace(li.textContent);
          if (text) lines.push(`- ${text}`);
        }
        continue;
      }

      if (tag === 'li') continue; // handled by parent

      if (tag === 'br') continue;

      // Bold text that looks like a section header
      if (tag === 'b' || tag === 'strong') {
        const text = normalizeSpace(child.textContent);
        if (
          text &&
          text.length < 80 &&
          (text.endsWith('?') ||
            text.endsWith(':') ||
            /^(Chi|La nostra|Cosa|Sede|Assunzione|Requisiti|Profilo|Il tuo|Le tue|Perch)/i.test(text))
        ) {
          lines.push('', `### ${text}`);
          continue;
        }
      }

      if (tag === 'div' || tag === 'p' || tag === 'span') {
        // If this element has child elements, recurse rather than flatten
        const hasChildElements = Array.from(child.childNodes).some((n) => n.nodeType === 1);
        if (hasChildElements) {
          processElement(child);
          continue;
        }
        const text = normalizeSpace(child.textContent);
        if (!text || text.length <= 1) continue;
        lines.push(text);
        continue;
      }

      // For other elements, recurse
      processElement(child);
    }
  }

  processElement(root);

  // Deduplicate consecutive identical lines and clean up
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' && result.length > 0 && result[result.length - 1].trim() === '') continue;
    if (result.length > 0 && result[result.length - 1].trim() === trimmed && trimmed !== '') continue;
    result.push(trimmed);
  }

  return result.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// Detail page fetcher — extracts embedded JSON from page HTML
// ─────────────────────────────────────────────────────────────

export async function fetchRelewantDetailPage(detailUrl, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(detailUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) {
      console.warn(`  ⚠️ Detail page HTTP ${res.status} for ${detailUrl}`);
      return null;
    }
    const html = await res.text();
    return extractEmbeddedJobData(html);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`  ⚠️ Detail page timeout for ${detailUrl}`);
    } else {
      console.warn(`  ⚠️ Detail page fetch error for ${detailUrl}: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the embedded `var jobs = JSON.parse('...')` data from the Zoho page HTML.
 */
export function extractEmbeddedJobData(html = '') {
  const startMarker = "var jobs = JSON.parse('";
  const idx1 = html.indexOf(startMarker);
  if (idx1 < 0) return null;

  const afterStart = idx1 + startMarker.length;
  const idx2 = html.indexOf("');", afterStart);
  if (idx2 < 0) return null;

  const escaped = html.substring(afterStart, idx2);
  try {
    const evaluated = new Function("return '" + escaped + "'")();
    const jobs = JSON.parse(evaluated);
    return Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null;
  } catch (err) {
    console.warn(`  ⚠️ Failed to parse embedded job JSON: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

export function validateRelewantDescription(markdown = '', sourceHtmlLength = 0) {
  const warnings = [];
  const textLength = markdown.replace(/[#\-*>\n]/g, ' ').replace(/\s+/g, ' ').trim().length;

  if (textLength < 200) {
    warnings.push(`Description too short: ${textLength} chars (minimum 200)`);
  }

  if (sourceHtmlLength > 0) {
    const ratio = textLength / sourceHtmlLength;
    if (ratio < 0.15) {
      warnings.push(`Coverage ratio too low: ${(ratio * 100).toFixed(1)}% (minimum 15%)`);
    }
  }

  const headings = (markdown.match(/^#{2,4}\s+/gm) || []).length;
  const listItems = (markdown.match(/^- /gm) || []).length;
  const paragraphs = markdown.split('\n\n').filter((b) => b.trim().length > 20).length;
  const blocks = headings + listItems + paragraphs;
  if (blocks < 3) {
    warnings.push(`Too few content blocks: ${blocks} (minimum 3)`);
  }

  return { ok: warnings.length === 0, warnings };
}

// ─────────────────────────────────────────────────────────────
// Public API — Listing fetcher
// ─────────────────────────────────────────────────────────────

/**
 * Fetch job listings from the Zoho Recruit public API.
 */
export async function fetchRelewantJobs(timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (payload?.code !== 'success' || !Array.isArray(payload?.data)) {
      throw new Error(`Unexpected API response: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a single Zoho Recruit job listing into a normalized object.
 */
export function parseRelewantJob(raw = {}) {
  const title = normalizeSpace(raw.Posting_Title || raw.Job_Opening_Name || '');
  const city = normalizeSpace(raw.City || '');
  const country = normalizeSpace(raw.Country || '');
  const jobType = normalizeSpace(raw.Job_Type || '');
  const id = String(raw.id || '');
  const detailUrl = String(raw.$url || '').replace(/\?.*$/, '');
  const applyUrl = detailUrl ? `${detailUrl}/apply` : '';

  return { title, city, country, jobType, id, detailUrl, applyUrl };
}

/**
 * Enrich a parsed job with detail page data (description, title validation, metadata).
 */
export async function enrichRelewantJob(parsed, timeoutMs = 15000) {
  const detail = await fetchRelewantDetailPage(parsed.detailUrl, timeoutMs);
  if (!detail) {
    return { ...parsed, description: '', detailTitle: '', enriched: false };
  }

  const detailTitle = normalizeSpace(detail.Posting_Title || detail.Job_Opening_Name || '');
  const descHtml = detail.Job_Description || '';
  const markdown = zohoHtmlToMarkdown(descHtml);

  // Title validation: use detail page title as source of truth
  let resolvedTitle = parsed.title;
  if (detailTitle) {
    const overlap = titleOverlap(parsed.title, detailTitle);
    if (overlap < 0.6) {
      console.warn(
        `  ⚠️ Title mismatch for ${parsed.id}: API="${parsed.title}" vs detail="${detailTitle}" (overlap=${overlap.toFixed(2)})`
      );
      resolvedTitle = detailTitle;
    }
  }

  // Validate description quality
  const validation = validateRelewantDescription(markdown, descHtml.length);
  if (!validation.ok) {
    for (const w of validation.warnings) {
      console.warn(`  ⚠️ ${parsed.id} — ${w}`);
    }
  }

  return {
    ...parsed,
    title: resolvedTitle,
    detailTitle,
    description: markdown,
    descriptionHtml: descHtml,
    workExperience: normalizeSpace(detail.Work_Experience || ''),
    industry: normalizeSpace(detail.Industry || ''),
    dateOpened: normalizeSpace(detail.Date_Opened || ''),
    state: normalizeSpace(detail.State || ''),
    zipCode: normalizeSpace(detail.Zip_Code || ''),
    enriched: true,
  };
}

/**
 * Build localized content for a ReleWant job.
 * If the job was enriched with detail page data, uses the full description.
 * Falls back to a generic template if not enriched.
 */
export function buildRelewantLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || '').trim() || 'Chiasso';
  const markdown = String(job.description || '').trim();

  let itDesc;
  if (markdown && markdown.length > 100) {
    const introLine = `## ${title}\n\n**ReleWant** — ${city}, Ticino, Svizzera`;
    const footerLines = [];
    if (job.workExperience) footerLines.push(`**Esperienza richiesta:** ${job.workExperience}`);
    if (job.industry) footerLines.push(`**Settore:** ${job.industry}`);
    footerLines.push(`**Sede:** ${city}, TI, Svizzera`);
    footerLines.push(`**Tipo:** ${job.jobType || 'A tempo pieno'}`);

    itDesc = [introLine, '', markdown, '', '---', ...footerLines].join('\n');
  } else {
    itDesc = `ReleWant, società di consulenza IT con sede a ${city}, cerca un profilo ${title}. ReleWant è specializzata in soluzioni informatiche innovative per il settore bancario e finanziario in Ticino. Candidati tramite il portale ufficiale.`;
  }

  // For enriched jobs, set the Italian description on all locales
  // (AI translation will fill the correct locale later)
  const enDesc = job.enriched
    ? itDesc
    : `ReleWant, an IT consulting firm based in ${city}, is looking for a ${title}. ReleWant specialises in innovative IT solutions for the banking and financial sector in Ticino. Apply through the official portal.`;
  const deDesc = job.enriched
    ? itDesc
    : `ReleWant, ein IT-Beratungsunternehmen mit Sitz in ${city}, sucht ein Profil als ${title}. ReleWant ist auf innovative IT-Lösungen für den Bank- und Finanzsektor im Tessin spezialisiert. Bewirb dich über das offizielle Portal.`;
  const frDesc = job.enriched
    ? itDesc
    : `ReleWant, société de conseil IT basée à ${city}, recherche un profil ${title}. ReleWant est spécialisée dans les solutions informatiques innovantes pour le secteur bancaire et financier au Tessin. Postulez via le portail officiel.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} relewant ${city}`),
      en: slugify(`${title} relewant ${city}`),
      de: slugify(`${title} relewant ${city}`),
      fr: slugify(`${title} relewant ${city}`),
    },
  };
}

/**
 * Check whether a job location is Ticino/Grigioni-relevant.
 */
export function isRelewantTicinoRelevant(city = '') {
  const loc = normalizeSpace(city);
  if (!loc) return true; // ReleWant is known TI company
  return isTargetSwissLocation(loc);
}
