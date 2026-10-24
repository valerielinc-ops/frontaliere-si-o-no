/**
 * Active-job JobPosting coverage — one contract, two observers.
 *
 * Owner decision (2026-10-24): every ACTIVE job detail page emits a valid
 * JobPosting. Between 2026-10-04 (PR 11394) and 2026-10-24 the build withheld
 * the schema from listings without a verified publication date, silently: the
 * page still rendered, nothing failed, and Google for Jobs clicks halved. The
 * guard therefore looks at the HTML that is actually written, not at the
 * builder's inputs, so it also covers incremental-cache reuse and any later
 * post-processing of the page.
 *
 *   1. In build: `createActiveJobPostingCoverage()` is fed every active
 *      canonical detail page right before it is queued for writing; the jobs
 *      SEO plugin throws if any page lacks JobPosting.
 *   2. Post build: the same tracker writes a sidecar (`JOBPOSTING_COVERAGE_OUT`)
 *      listing those pages; `scripts/ci/assert-active-jobposting-coverage.mjs`
 *      re-reads each file from the final `dist/` and fails the deploy when one
 *      lost its JobPosting, or when the sidecar is missing.
 *
 * Zero tolerance: this judges what THIS build emits (AGENTS.md Non-Negotiable
 * #1), so no rate threshold applies. The rate is still printed on every run.
 */
import { extractJobPostingNodesFromJson } from './jobposting-jsonld.mjs';

const LD_JSON_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
const ROBOTS_META_RE = /<meta\b[^>]*\bname\s*=\s*["']?robots["']?[^>]*>/gi;
const CONTENT_ATTR_RE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Return the JobPosting nodes of a page. A JSON-LD block that does not parse
 * counts as no JobPosting: Google cannot read it either.
 *
 * @param {string} html
 * @returns {object[]}
 */
export function extractJobPostingsFromHtml(html) {
  const out = [];
  for (const match of String(html || '').matchAll(LD_JSON_RE)) {
    const raw = String(match[1] || '').trim();
    // Cheap pre-filter: only blocks that mention the type are parsed (an
    // active page also carries Breadcrumb/FAQ/WebPage blocks).
    if (!raw || !raw.includes('JobPosting')) continue;
    try {
      out.push(...extractJobPostingNodesFromJson(JSON.parse(raw)));
    } catch {
      // unparseable: not a JobPosting Google can use
    }
  }
  return out;
}

/**
 * A JSON-LD value is usable as `datePosted` only when it is an ISO calendar
 * date or an ISO timestamp with an explicit timezone.  Truthiness is not
 * enough here: objects, booleans and arbitrary strings serialize into markup
 * that Google cannot interpret as a publication date.
 */
function isValidatedIsoDate(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendar = new Date(`${yearText}-${monthText}-${dayText}T00:00:00.000Z`);
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() + 1 !== month
    || calendar.getUTCDate() !== day
  ) return false;
  if (hourText !== undefined && (
    Number(hourText) > 23
    || Number(minuteText) > 59
    || Number(secondText || 0) > 59
  )) return false;
  return Number.isFinite(Date.parse(raw));
}

/** True when the page carries at least one JobPosting with a datePosted. */
export function htmlHasActiveJobPosting(html) {
  return extractJobPostingsFromHtml(html).some((node) => isValidatedIsoDate(node?.datePosted));
}

/** True unless a robots meta says noindex. */
export function htmlIsIndexable(html) {
  for (const match of String(html || '').matchAll(ROBOTS_META_RE)) {
    const content = CONTENT_ATTR_RE.exec(match[0]);
    const value = String(content?.[1] ?? content?.[2] ?? content?.[3] ?? '').toLowerCase();
    if (value.includes('noindex')) return false;
  }
  return true;
}

/**
 * @param {{ keepPages?: boolean, expectedTotal?: number | null }} [options]
 *   keepPages retains the page list; expectedTotal is the independent active
 *   population computed by the emitter before the page loop.
 *   for the post-build sidecar; without it only counters and misses are kept
 *   (the full build emits ~130k active details: no list unless asked for).
 * @returns {{
 *   record: (locale: string, pagePath: string, html: string) => void,
 *   setExpectedTotal: (value: number) => void,
 *   summary: () => { pages: number, expectedTotal: number | null, indexable: number, withJobPosting: number, missing: { locale: string, path: string, indexable: boolean }[] },
 *   sidecar: () => object,
 *   assertComplete: (label?: string) => void,
 * }}
 */
export function createActiveJobPostingCoverage({ keepPages = false, expectedTotal: configuredExpectedTotal = null } = {}) {
  const pages = [];
  let total = 0;
  let expectedTotal = configuredExpectedTotal;
  const missing = [];
  let indexable = 0;
  let withJobPosting = 0;
  return {
    record(locale, pagePath, html) {
      const isIndexable = htmlIsIndexable(html);
      const hasJobPosting = htmlHasActiveJobPosting(html);
      total += 1;
      if (keepPages) pages.push({ locale, path: pagePath, indexable: isIndexable });
      if (isIndexable) indexable += 1;
      if (hasJobPosting) withJobPosting += 1;
      else missing.push({ locale, path: pagePath, indexable: isIndexable });
    },
    setExpectedTotal(value) {
      if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`jobposting-coverage expectedTotal must be a non-negative integer, got ${value}`);
      }
      expectedTotal = value;
    },
    summary() {
      return { pages: total, expectedTotal, indexable, withJobPosting, missing: [...missing] };
    },
    sidecar() {
      return {
        version: 1,
        generatedAt: new Date().toISOString(),
        expectedTotal,
        total,
        pages: [...pages],
      };
    },
    assertComplete(label = 'jobposting-coverage') {
      const rate = total === 0 ? 100 : (100 * withJobPosting) / total;
      console.log(
        `[${label}] active=${total} indexable=${indexable} with-jobposting=${withJobPosting} `
        + `missing=${missing.length} rate=${rate.toFixed(3)}%`,
      );
      if (expectedTotal !== null && total !== expectedTotal) {
        throw new Error(
          `[${label}] active population mismatch: expected ${expectedTotal} page(s), recorded ${total}`,
        );
      }
      if (missing.length === 0) return;
      const sample = missing.slice(0, 20).map((entry) => `  - ${entry.locale} ${entry.path}${entry.indexable ? '' : ' (noindex)'}`);
      throw new Error(
        `[${label}] ${missing.length} active job detail page(s) emitted without JobPosting JSON-LD. `
        + 'An active job ALWAYS carries JobPosting (docs/SEO-RULES.md):\n'
        + sample.join('\n')
        + (missing.length > sample.length ? `\n  … and ${missing.length - sample.length} more` : ''),
      );
    },
  };
}

/**
 * Verify the sidecar against the final dist. Returns a report; the CLI turns
 * any `missing`/`unreadable` entry into a failing exit code.
 *
 * @param {{ pages?: { locale: string, path: string, indexable?: boolean }[] }} sidecar
 * @param {(pagePath: string) => string | null} readPage returns the HTML of a
 *   dist page path, or null when the file is absent from this dist
 */
export function verifyActiveJobPostingCoverage(sidecar, readPage) {
  const report = { pages: 0, checked: 0, absent: 0, withJobPosting: 0, missing: [] };
  for (const page of Array.isArray(sidecar?.pages) ? sidecar.pages : []) {
    report.pages += 1;
    const html = readPage(page.path);
    if (html === null) {
      report.absent += 1;
      continue;
    }
    report.checked += 1;
    if (htmlHasActiveJobPosting(html)) report.withJobPosting += 1;
    else report.missing.push(page);
  }
  return report;
}
