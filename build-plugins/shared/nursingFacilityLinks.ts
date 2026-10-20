export const NURSING_FACILITIES_ANCHOR = '<!-- nursing-facilities-after-guide -->';

/** Preserve the guide's title, jobs and explanation before additional facilities. */
export function injectNursingFacilityLinks(html: string, block: string, marker: string) {
  if (html.includes(marker)) return { html, outcome: 'duplicate' as const };
  const anchor = NURSING_FACILITIES_ANCHOR;
  if (html.includes(anchor)) return { html: html.replace(anchor, `${anchor}${block}`), outcome: 'inserted' as const };
  // Older/below-floor shells have no marker; retain links at the end of main.
  if (html.includes('</main>')) return { html: html.replace('</main>', `${block}</main>`), outcome: 'inserted' as const };
  return { html, outcome: 'no-anchor' as const };
}
