/**
 * Extract a display-safe hostname from an absolute URL (`www.` stripped,
 * lowercased). Returns `''` on malformed/relative input — callers decide
 * the fallback.
 *
 * Shared so the same extraction logic isn't copy-pasted per call site
 * (CLAUDE.md #6): originally a private closure in `jobsSeoPagesPlugin.ts`
 * (`companyWebsite`'s domain resolution), now also used by
 * `jobPostingFaq.ts` to avoid embedding a third-party ATS's raw URL path
 * (which can contain arbitrary encoding artifacts, e.g. Rheinmetall's
 * `___` space/paren escaping) as visible prose text.
 */
export function hostFromUrl(raw?: string): string {
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}
