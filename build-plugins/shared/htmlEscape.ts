/**
 * HTML entity escaping for static-page build plugins.
 *
 * Replaces the local `escHtml`/`esc` helpers that were independently
 * defined in jobCardHtml, employerCardHtml, landingHeroPersonality and
 * relatedLinks. All four had identical implementations — extracting
 * removes the DRY violation flagged in the canonical-card review.
 */
export function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
