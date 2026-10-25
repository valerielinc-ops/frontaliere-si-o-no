/**
 * Clipboard copy-attribution for gated job listings.
 *
 * PostHog session replays (e.g. session 019ed485-da3e-7e27-a687-cf99aaba27e6)
 * show users landing on the application auth gate, copying the first lines of
 * the job teaser, and pasting them into Google to track the listing down. That
 * copy currently carries ZERO of our branding, so the user is handed straight
 * to the original source / a competitor.
 *
 * We hijack the `copy` event over the gate and append our brand + an attributed
 * URL of the listing to whatever the user selected:
 *  - text/plain: the pasted text now ends with the exact job title + brand +
 *    our URL. Dropped into a search box, that query biases the result back to
 *    our listing (brand + title + URL literally present).
 *  - text/html: a real <a> backlink, so pasting into a rich editor / forum /
 *    social post / doc produces an attributed link to us.
 *
 * The UTM parameters live only in the copied URL. They do not change the page's
 * canonical URL, and let the landing session be recognized as a copy-attribution
 * visit by the existing analytics/UTM pipeline.
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

export const JOB_COPY_SITE_ORIGIN = 'https://frontaliereticino.ch';
export const JOB_COPY_UTM_SOURCE = 'frontaliereticino';
export const JOB_COPY_UTM_MEDIUM = 'referral';
export const JOB_COPY_UTM_CAMPAIGN = 'job_copy_attribution';

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

export type JobCopyAttributionSelectionInput = Omit<JobCopyAttributionInput, 'selectionText' | 'selectionHtml'>;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Collapse whitespace + lowercase so a copied selection can be matched
 * against the rendered job title regardless of incidental spacing/case. */
const normalizeForTitleMatch = (s: string): string =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Add attribution dimensions to the URL copied from an AuthGate.
 *
 * The input is expected to be an absolute first-party URL. If a malformed or
 * external URL reaches this helper, leave it untouched rather than creating a
 * surprising redirect/link target in the user's clipboard.
 */
export function buildJobCopyAttributionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== JOB_COPY_SITE_ORIGIN) return url;
    parsed.searchParams.set('utm_source', JOB_COPY_UTM_SOURCE);
    parsed.searchParams.set('utm_medium', JOB_COPY_UTM_MEDIUM);
    parsed.searchParams.set('utm_campaign', JOB_COPY_UTM_CAMPAIGN);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * True when a selection is worth attributing. A selection at or above the
 * tiny-copy floor always qualifies. In addition, a selection that IS the job
 * title (case/whitespace-insensitive) qualifies even when it falls under the
 * floor — short titles like "Cuoco" are exactly the snippet users paste into a
 * search box, and must still carry our brand + canonical URL instead of handing
 * the searcher straight to a competitor.
 */
export function shouldAttributeCopy(selectionText: string, jobTitle?: string): boolean {
  if (selectionText.trim().length >= COPY_ATTRIBUTION_MIN_CHARS) return true;
  if (jobTitle) {
    const title = normalizeForTitleMatch(jobTitle);
    if (title && normalizeForTitleMatch(selectionText) === title) return true;
  }
  return false;
}

function selectionNodeIsInsideScope(scope: Node, node: Node): boolean {
  const candidate = node.nodeType === 3 ? node.parentNode : node;
  return !!candidate && (candidate === scope || scope.contains(candidate));
}

/**
 * Return true only when every selected range belongs to the card that owns the
 * copy handler. This prevents a handler on a gate layout from attributing text
 * copied from an ad rail, navigation control, or another sibling surface.
 */
export function isSelectionWithinScope(selection: Selection | null, scope: Node | null): boolean {
  if (!selection || !scope || selection.rangeCount === 0) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    if (!selectionNodeIsInsideScope(scope, selection.getRangeAt(i).commonAncestorContainer)) {
      return false;
    }
  }
  return true;
}

/** Serialize the selected rich text for the `text/html` clipboard flavor. */
export function serializeSelectionHtml(selection: Selection | null): string {
  if (!selection || selection.rangeCount === 0 || typeof document === 'undefined') return '';
  const holder = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) {
    holder.appendChild(selection.getRangeAt(i).cloneContents());
  }
  return holder.innerHTML;
}

/**
 * Build an attributed clipboard payload from a browser selection, or return
 * null when the selection is outside the intended scope / too small to matter.
 */
export function buildJobCopyAttributionFromSelection(
  selection: Selection | null,
  scope: Node | null,
  input: JobCopyAttributionSelectionInput,
): JobCopyClipboard | null {
  if (!isSelectionWithinScope(selection, scope)) return null;
  const selectionText = selection?.toString() ?? '';
  if (!shouldAttributeCopy(selectionText, input.jobTitle)) return null;
  return buildJobCopyAttribution({
    ...input,
    selectionText,
    selectionHtml: serializeSelectionHtml(selection),
  });
}

/**
 * Build the `text/plain` + `text/html` clipboard payloads that append brand +
 * canonical-URL attribution to a user's selection.
 */
export function buildJobCopyAttribution(input: JobCopyAttributionInput): JobCopyClipboard {
  const { selectionText, selectionHtml, jobTitle, company, url, lead } = input;
  const titleLine = company ? `${jobTitle} – ${company}` : jobTitle;
  const attributedUrl = buildJobCopyAttributionUrl(url);

  const text = `${selectionText}\n\n${lead}\n${titleLine}\n${attributedUrl}`;

  const baseHtml = selectionHtml && selectionHtml.trim() ? selectionHtml : escapeHtml(selectionText);
  const html =
    `${baseHtml}<br><br>${escapeHtml(lead)}<br>` +
    `<a href="${escapeHtml(attributedUrl)}">${escapeHtml(titleLine)}</a>`;

  return { text, html };
}
