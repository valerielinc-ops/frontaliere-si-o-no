/**
 * Return an absolute HTTPS URL only when it is safe to publish as a link.
 * Userinfo is deliberately rejected, including percent-encoded credentials.
 * @param {unknown} value
 * @returns {string | null}
 */
export function httpsUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!/^https:\/\/[^\s"<>]+$/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return url.hostname && !url.username && !url.password ? candidate : null;
  } catch {
    return null;
  }
}
