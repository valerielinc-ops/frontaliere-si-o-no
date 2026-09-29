/**
 * Banca Cler job detail parser.
 * Converts rich HTML from cler.ch career pages to structured markdown.
 */
import { JSDOM } from 'jsdom';
import { extractStableJobId } from './job-match-key.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/**
 * Validate the Cler listing envelope and reconcile it with the source total.
 *
 * `results: []` is a legitimate empty board only when the API also reports
 * `resultsTotalCount: 0`. A malformed envelope, a missing total, or a page
 * shorter than the declared total is an unproven/partial read and must fail
 * before the caller can treat it as a zero-job refresh.
 *
 * @param {unknown} data parsed Cler jobssearch response
 * @param {{ allowPartial?: boolean }} [options] A page may be shorter than
 *   the declared total only while the caller is walking subsequent pages.
 * @returns {{ listings: object[], declaredTotal: number, sourceEmptyProven: boolean }}
 */
export function parseClerApiResponse(data, { allowPartial = false } = {}) {
  const listings = assertJsonListShape(data, { key: 'results', source: 'cler' });
  const hasResultsArray = data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && Array.isArray(data.results);
  if (!hasResultsArray) {
    throw new Error('Cler source response did not expose a results array; refusing an unproven zero-job refresh.');
  }

  const rawTotal = data.resultsTotalCount;
  const declaredTotal = typeof rawTotal === 'number'
    ? rawTotal
    : typeof rawTotal === 'string' && rawTotal.trim() !== ''
      ? Number(rawTotal)
      : Number.NaN;
  if (!Number.isSafeInteger(declaredTotal) || declaredTotal < 0) {
    throw new Error('Cler source response did not expose a valid resultsTotalCount; completeness is unverified.');
  }
  if (listings.length > declaredTotal || (!allowPartial && listings.length !== declaredTotal)) {
    throw new Error(
      `Cler source listing is ${listings.length > declaredTotal ? 'larger than' : 'shorter than'} `
      + `the declared total: API declares ${declaredTotal} listings but returned ${listings.length}; `
      + 'refusing a truncated or unproven refresh.',
    );
  }

  return {
    listings,
    declaredTotal,
    sourceEmptyProven: declaredTotal === 0,
  };
}

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
 * drops a job. This only triggers when `getUrl(item)` returns '' (the API
 * listing carries no link at all) — whenever a URL IS present,
 * `extractStableJobId` always resolves a non-empty, stable key.
 *
 * #5230 — "non-empty and stable" was necessary but NOT sufficient, and the
 * gap re-opened #3836 for a whole class of postings. Rule K originally fired
 * only when the leaf ENDED in a digit run; Cler's apprenticeship/internship
 * slugs carry no requisition suffix, so they fell through to Rule C's
 * whole-URL key. That key is perfectly stable and non-empty — and DIFFERENT
 * for the two career-section paths, so the pair never collapsed and every
 * such posting was emitted twice (banca-cler 18/22 = 82%, the audit's only
 * CRITICAL crawler). Rule K now falls back to a leaf-based
 * `req:cler.ch:slug:<leaf>` key for the `/offene-stellen/<slug>` detail
 * shape, which is invariant across both the career-section split and the
 * de/it locale paths. Covered by tests/job-url-key.test.ts +
 * tests/cler-crawler.test.ts.
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

/**
 * Collapse, in the stored slice, records that are the same Cler requisition
 * (`extractStableJobId`) under different locale / career-section paths.
 *
 * `dedupeClerJobsByStableId` runs on the API listing and `mergeJobs` dedupes
 * the discovered jobs, but the shared base crawler that runs AFTER them
 * (`runDedicatedBaseCrawler`, adapter seeds = the it/de/fr/en listing pages)
 * re-adds the same requisition under another path: the committed slice of
 * 2026-09-29 carried `…/de/…-2743` + `…/fr/…-2743` and
 * `…/jobs-und-karriere/…-2719` + `…/jobs-und-karriere-2026/…-2719`, each
 * pair with the same id, title, location and body (dup 4/12).
 *
 * Survivor per requisition: the URL the dedicated discovery published this
 * run, else the newest career-section path, else the first record. Returns
 * the survivors (input order) and the dropped records with their survivor, so
 * the caller can carry the dropped slugs into the survivor's history.
 *
 * @param {Array<object>} jobs
 * @param {Set<string>} [preferredUrls]
 * @returns {{ jobs: object[], dropped: Array<{ dropped: object, kept: object }> }}
 */
export function collapseClerDuplicateRequisitions(jobs = [], preferredUrls = new Set()) {
  const groups = new Map();
  const order = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = extractStableJobId(job?.url || '');
    if (!key) { order.push({ single: job }); continue; }
    if (!groups.has(key)) { groups.set(key, []); order.push({ key }); }
    groups.get(key).push(job);
  }
  const rank = (job) => [
    preferredUrls.has(job?.url) ? 1 : 0,
    clerCareerSectionYear(job?.url || ''),
  ];
  const better = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };
  const out = [];
  const dropped = [];
  for (const entry of order) {
    if (entry.single) { out.push(entry.single); continue; }
    const group = groups.get(entry.key);
    let kept = group[0];
    for (const job of group.slice(1)) if (better(job, kept)) kept = job;
    out.push(kept);
    for (const job of group) if (job !== kept) dropped.push({ dropped: job, kept });
  }
  return { jobs: out, dropped };
}

/**
 * The stand-in earlier runs published when a detail page gave no usable
 * body: "## <title>\n\nBanca Cler — per i dettagli consultare la pagina
 * dell'offerta." (and its translations, which keep the "Banca Cler —" lead).
 * It is not source text and is never published again; it is recognised only
 * to clear stale copies from stored records.
 */
export function isClerPlaceholderDescription(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/per i dettagli consultare la pagina dell['’]offerta/i.test(value)) return true;
  return value.length < 300 && /^##[^\n]*\n+\s*Banca Cler\s*[—–-]/.test(value);
}

/**
 * Source text of a stored record (source-locale slot, then description) that
 * clears the shared word floor, or null.
 */
export function storedClerSourceText(record) {
  if (!record) return null;
  const lang = String(record.sourceLang || '').trim();
  for (const candidate of [record.descriptionByLocale?.[lang], record.description]) {
    const text = String(candidate || '').trim();
    if (text && !isClerPlaceholderDescription(text) && meetsSourceBodyFloor(text)) return { text, lang };
  }
  return null;
}

/**
 * Source-only rule for a discovered job whose detail page gave no body (or
 * one under the shared word floor): the stored source text of the same
 * requisition, or `null` (not published this run). A job with a body is
 * returned unchanged.
 */
export function resolveClerJobBody(job, prev) {
  if (meetsSourceBodyFloor(job?.description || '')) return job;
  const stored = storedClerSourceText(prev);
  if (!stored) return null;
  const lang = stored.lang || job.sourceLang;
  return { ...job, description: stored.text, sourceLang: lang, descriptionByLocale: { [lang]: stored.text } };
}

/** Remove placeholder copies from every locale slot (in place). */
export function clearClerPlaceholderSlots(job) {
  let removed = 0;
  for (const [locale, text] of Object.entries(job?.descriptionByLocale || {})) {
    if (isClerPlaceholderDescription(text)) {
      delete job.descriptionByLocale[locale];
      removed += 1;
    }
  }
  return removed;
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
