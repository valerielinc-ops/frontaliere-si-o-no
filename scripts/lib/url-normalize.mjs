/**
 * Normalize a frontaliere URL for GSC URL Inspection API.
 * All top-level routes are emitted with trailing slash in dist/ (and
 * the no-slash variant is a bridge with noindex,follow). Inspecting
 * the no-slash variant returns "Excluded by noindex tag" — a false
 * negative. Always inspect the canonical (trailing-slash) form.
 */
export function normalizeInspectionUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    const hasExtension = last && /\.[a-z0-9]+$/i.test(last);
    if (!u.pathname.endsWith('/') && !hasExtension) {
      u.pathname += '/';
    }
    return u.toString();
  } catch {
    return url;
  }
}
