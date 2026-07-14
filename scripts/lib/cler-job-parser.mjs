/**
 * Banca Cler job detail parser.
 * Converts rich HTML from cler.ch career pages to structured markdown.
 */
import { JSDOM } from 'jsdom';
import { extractStableJobId } from './job-match-key.mjs';

/**
 * Newest career-section year embedded in a Cler job URL, or 0 when the path
 * carries no year suffix. Since the 2026-07 relaunch the jobssearch API
 * publishes every posting under BOTH the legacy `…/jobs-und-karriere/…` path
 * and the new `…/jobs-und-karriere-2026/…` path — same requisition id, two
 * URLs. The year suffix marks the CANONICAL (live) section, so a higher year
 * wins when we collapse the two records into one.
 */
export function clerCareerSectionYear(url = '') {
  const m = String(url || '').match(/jobs-und-karriere-(\d{4})\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Deduplicate Cler job records that resolve to the SAME posting.
 *
 * Root cause (#3836): the jobssearch API returns each open position twice —
 * once under the legacy `…/jobs-und-karriere/…` path and once under the
 * relaunched `…/jobs-und-karriere-2026/…` path — with the SAME 3-4 digit
 * requisition id in the leaf but two distinct whole URLs. The Cler requisition
 * id is below the generic ≥6-digit stable-id floor, so before Rule K
 * (job-url-key.mjs) every URL keyed to itself and each role emitted twice
 * (12 records / 6 real jobs → duplicate-listings ratchet). Keying on the
 * stable requisition id (`extractStableJobId` → `req:cler.ch:<id>`) collapses
 * the pair; we keep ONE record per id, preferring the canonical (newest
 * career-section) URL so the survivor points at the live path.
 *
 * Records with no derivable stable id (no url and no slug) are preserved
 * as-is under a per-record synthetic key so a missing id never silently
 * drops a job.
 *
 * @param {Array<object>} items
 * @param {(item: object) => string} [getUrl] URL accessor (default `item.url`)
 * @returns {Array<object>} one record per distinct requisition id
 */
export function dedupeClerJobsByStableId(items, getUrl = (it) => it?.url) {
  const byKey = new Map();
  let synthetic = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const url = getUrl(item) || '';
    const key = extractStableJobId(url)
      || String(item?.slug || '').trim().toLowerCase()
      || `__nokey_${synthetic++}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, item); continue; }
    // Keep whichever URL is more canonical (newest career-section year).
    if (clerCareerSectionYear(url) > clerCareerSectionYear(getUrl(prev) || '')) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

// Localized labels Cler exposes in `.JobDetail__item`. Multilingual to survive
// any future locale switch of the source site.
const META_LABELS = {
  arbeitsort: ['arbeitsort', 'lieu de travail', 'luogo di lavoro', 'workplace', 'work location'],
  pensum:     ['pensum', 'taux d\'occupation', 'percentuale', 'workload'],
  start:      ['stellenantritt', 'entrée en fonction', 'inizio', 'start date'],
  bereich:    ['bereich / abteilung', 'domaine / département', 'ambito / reparto', 'department'],
};

function pickMetaValue(meta, kind) {
  const wanted = META_LABELS[kind];
  if (!wanted) return '';
  for (const [rawKey, val] of Object.entries(meta)) {
    const k = rawKey.toLowerCase().trim();
    if (wanted.some((w) => k === w || k.startsWith(w))) return val;
  }
  return '';
}

/**
 * Extract structured job metadata (location, workload, start date, department)
 * from a Cler detail page. Returns empty strings for any field not present.
 */
export function extractJobMeta(html) {
  if (!html) return { arbeitsort: '', pensum: '', start: '', bereich: '', raw: {} };
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const meta = {};
  for (const item of doc.querySelectorAll('.JobDetail__item')) {
    const slots = item.querySelectorAll('.JobDetail__item-slot');
    if (slots.length >= 2) {
      const key = slots[0].textContent.trim();
      const val = slots[1].textContent.trim();
      if (key && val) meta[key] = val;
    }
  }
  return {
    arbeitsort: pickMetaValue(meta, 'arbeitsort'),
    pensum:     pickMetaValue(meta, 'pensum'),
    start:      pickMetaValue(meta, 'start'),
    bereich:    pickMetaValue(meta, 'bereich'),
    raw: meta,
  };
}

/**
 * Convert Cler job detail HTML to structured markdown.
 * Parses `.m-richtext__content` for headings, paragraphs, and lists,
 * plus `.JobDetail__list` for metadata (department, location, workload, start date).
 */
export function htmlToMarkdown(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const parts = [];

  // 1) Extract metadata from JobDetail list
  const metaItems = doc.querySelectorAll('.JobDetail__item');
  const meta = {};
  for (const item of metaItems) {
    const slots = item.querySelectorAll('.JobDetail__item-slot');
    if (slots.length >= 2) {
      const key = slots[0].textContent.trim();
      const val = slots[1].textContent.trim();
      if (key && val) meta[key] = val;
    }
  }

  // 2) Extract richtext content
  const richtext = doc.querySelector('.m-richtext__content');
  if (!richtext) return '';

  for (const child of richtext.children) {
    const tag = child.tagName.toUpperCase();
    const text = child.textContent.trim();
    if (!text) continue;

    if (tag === 'H1') {
      parts.push(`## ${text}`);
    } else if (tag === 'H2' || tag === 'H3') {
      // Skip "Noch Fragen?" / "Des questions?" / contact sections
      if (/^noch fragen|^des questions|^domande/i.test(text)) break;
      parts.push(`### ${text}`);
    } else if (tag === 'P') {
      // Clean up excessive whitespace from CMS
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 10) parts.push(cleaned);
    } else if (tag === 'UL' || tag === 'OL') {
      const items = child.querySelectorAll('li');
      for (const li of items) {
        const liText = li.textContent.trim().replace(/\s+/g, ' ');
        if (liText) parts.push(`- ${liText}`);
      }
    }
  }

  // 3) Append metadata footer if available
  const metaLines = [];
  for (const [key, val] of Object.entries(meta)) {
    metaLines.push(`**${key}:** ${val}`);
  }
  if (metaLines.length > 0) {
    parts.push('---');
    parts.push(metaLines.join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * Validate a Cler job description for quality.
 * Returns { ok: boolean, warnings: string[] }.
 */
export function validateClerDescription(description, sourceTextLength = 0) {
  const warnings = [];
  const descLen = (description || '').length;

  if (descLen < 350) {
    warnings.push(`Description too short: ${descLen} chars (min 350)`);
  }

  // Must have at least one section heading (### in markdown)
  if (!/^###\s/m.test(description || '')) {
    warnings.push('No section headings found (expected ### Dein neuer Job, ### Davon profitieren wir, etc.)');
  }

  // Must have list items (responsibilities or requirements)
  const listItems = ((description || '').match(/^- /gm) || []).length;
  if (listItems < 2) {
    warnings.push(`Too few list items: ${listItems} (expected ≥ 2)`);
  }

  // Coverage ratio check (markdown is denser than raw source text)
  if (sourceTextLength > 200 && descLen / sourceTextLength < 0.15) {
    warnings.push(`Low source coverage: ${descLen}/${sourceTextLength} = ${(descLen / sourceTextLength).toFixed(2)}`);
  }

  return { ok: warnings.length === 0, warnings };
}
