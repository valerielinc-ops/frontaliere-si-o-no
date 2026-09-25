/**
 * Company logo probe — verifies a candidate's own domain actually serves a
 * recognisable logo, BEFORE the candidate is allowed into production.
 *
 * Unlike `scripts/download-missing-company-logos.mjs` (which must GUESS a
 * domain for an arbitrary company name by trying several candidate domains),
 * a prospector candidate already carries `spec.companyHost` — the real domain
 * its career page was synthesised from (see
 * `scripts/lib/prospector/synthesize.mjs`). So this is a direct verification
 * against a known domain, not a multi-domain guess: no candidate-domain
 * generation needed here.
 *
 * Same acquisition technique as `download-missing-company-logos.mjs`: Google's
 * favicon endpoint, with the same "grey globe" detection (Google's generic
 * fallback icon for a domain it can't resolve a real favicon for). Clearbit is
 * NOT used — its logo CDN is defunct (see the guard comment in
 * `services/jobDataNormalization.ts`), so a probe against it would always
 * read as "no logo" regardless of the real answer.
 */
import { validateLogoReference } from '../company-logo-audit.mjs';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * @param {string} host bare hostname, e.g. `'lonza.com'`
 * @returns {Promise<{ found: boolean, domain?: string, size?: number, reason?: string }>}
 */
export async function probeCompanyLogo(host) {
  const domain = String(host || '').trim();
  if (!domain) return { found: false, reason: 'nessun dominio' };

  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  const result = await validateLogoReference(
    { kind: 'external', reference: url },
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (result.status !== 'valid') {
    const reason = result.reason === 'grey-globe'
      ? 'grey-globe (dominio senza favicon)'
      : result.reason || 'logo non verificato';
    return { found: false, domain, reason };
  }
  return { found: true, domain, size: result.bytes };
}
