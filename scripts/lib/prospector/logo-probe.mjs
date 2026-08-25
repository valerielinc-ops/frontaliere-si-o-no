/**
 * Company logo probe — verifies a candidate's own domain actually serves a
 * recognisable logo, BEFORE the candidate is allowed into production.
 *
 * Unlike `scripts/download-missing-company-logos.mjs` (which must GUESS a
 * domain for an arbitrary company name via `domainCandidates()`), a prospector
 * candidate already carries `spec.companyHost` — the real domain its career
 * page was synthesised from (see `scripts/lib/prospector/synthesize.mjs`).
 * So this is a direct verification against a known domain, not a multi-domain
 * guess: no `domainCandidates()`/`STRIP_SUFFIXES` needed here.
 *
 * Same acquisition technique as `download-missing-company-logos.mjs`: Google's
 * favicon endpoint, with the same 726-byte "grey globe" detection (Google's
 * generic fallback icon for a domain it can't resolve a real favicon for).
 * Clearbit is NOT used — its logo CDN is defunct (see the guard comment in
 * `services/jobDataNormalization.ts`), so a probe against it would always
 * read as "no logo" regardless of the real answer.
 */

const FETCH_TIMEOUT_MS = 10_000;
const GREY_GLOBE_SIZE = 726; // bytes — Google's generic globe at sz=128

/**
 * @param {string} host bare hostname, e.g. `'lonza.com'`
 * @returns {Promise<{ found: boolean, domain?: string, size?: number, reason?: string }>}
 */
export async function probeCompanyLogo(host) {
  const domain = String(host || '').trim();
  if (!domain) return { found: false, reason: 'nessun dominio' };

  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoLogoBot/1.0)' },
    });
    if (!res.ok) return { found: false, domain, reason: `http ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { found: false, domain, reason: 'risposta vuota' };
    if (buf.length === GREY_GLOBE_SIZE) return { found: false, domain, reason: 'grey-globe (dominio senza favicon)' };
    return { found: true, domain, size: buf.length };
  } catch (err) {
    return { found: false, domain, reason: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
