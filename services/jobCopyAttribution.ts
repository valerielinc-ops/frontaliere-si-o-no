/**
 * Clipboard copy-attribution for gated job listings.
 *
 * PostHog session replays (e.g. session 019ed485-da3e-7e27-a687-cf99aaba27e6)
 * show users landing on the application auth gate, copying the first lines of
 * the job teaser, and pasting them into Google to track the listing down. That
 * copy currently carries ZERO of our branding, so the user is handed straight
 * to the original source / a competitor.
 *
 * We hijack the `copy` event over the gate and append our brand + the canonical
 * URL of the listing to whatever the user selected:
 *  - text/plain: the pasted text now ends with the exact job title + brand +
 *    our URL. Dropped into a search box, that query biases the result straight
 *    back to OUR canonical (brand + title + URL literally present).
 *  - text/html: a real <a> backlink, so pasting into a rich editor / forum /
 *    social post / doc produces an attributed link to us.
 *
 * This only rewrites what the user already chose to copy — no monetization /
 * Auto Ads / layout impact.
 */

/**
 * Minimum selection length (trimmed) before we append attribution. Tiny copies
 * (a single word, a number, a date) are left untouched so the feature never
 * gets in the way of a deliberate snippet.
 */
export const COPY_ATTRIBUTION_MIN_CHARS = 25;

export interface JobCopyAttributionInput {
  /** Plain-text of the user's current selection. */
  selectionText: string;
  /** Serialized HTML of the selection, when available (rich copy). */
  selectionHtml?: string;
  jobTitle: string;
  company?: string;
  /** Absolute canonical URL of the job detail page (trailing slash). */
  url: string;
  /** Localized lead line, e.g. "Annuncio completo su Frontaliere Ticino:". */
  lead: string;
}

export interface JobCopyClipboard {
  text: string;
  html: string;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * True when a selection is long enough to be worth attributing.
 */
export function shouldAttributeCopy(selectionText: string): boolean {
  return selectionText.trim().length >= COPY_ATTRIBUTION_MIN_CHARS;
}

/**
 * Build the `text/plain` + `text/html` clipboard payloads that append brand +
 * canonical-URL attribution to a user's selection.
 */
export function buildJobCopyAttribution(input: JobCopyAttributionInput): JobCopyClipboard {
  const { selectionText, selectionHtml, jobTitle, company, url, lead } = input;
  const titleLine = company ? `${jobTitle} – ${company}` : jobTitle;

  const text = `${selectionText}\n\n${lead}\n${titleLine}\n${url}`;

  const baseHtml = selectionHtml && selectionHtml.trim() ? selectionHtml : escapeHtml(selectionText);
  const html =
    `${baseHtml}<br><br>${escapeHtml(lead)}<br>` +
    `<a href="${escapeHtml(url)}">${escapeHtml(titleLine)}</a>`;

  return { text, html };
}
