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
 * The probe reads only favicon paths served by the candidate's own domain. A
 * proxy or third-party favicon CDN would make a positive result unrelated to
 * the asset source that can later be mirrored to our stable CDN. Clearbit is
 * NOT used — its logo CDN is defunct (see the guard comment in
 * `services/jobDataNormalization.ts`), so a probe against it would always
 * read as "no logo" regardless of the real answer.
 */
import { validateLogoReference } from '../company-logo-audit.mjs';

const FETCH_TIMEOUT_MS = 10_000;

function officialFaviconUrls(domain) {
  const urls = [`https://${domain}/favicon.ico`];
  if (!/^www\./i.test(domain)) urls.push(`https://www.${domain}/favicon.ico`);
  return urls;
}

/**
 * @param {string} host bare hostname, e.g. `'lonza.com'`
 * @returns {Promise<{ found: boolean, domain?: string, size?: number, source?: string, reason?: string }>}
 */
export async function probeCompanyLogo(host) {
  const domain = String(host || '').trim();
  if (!domain) return { found: false, reason: 'nessun dominio' };

  let lastReason = 'logo non verificato';
  for (const url of officialFaviconUrls(domain)) {
    const result = await validateLogoReference(
      { kind: 'external', reference: url },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (result.status === 'valid') {
      return { found: true, domain, size: result.bytes, source: url };
    }
    lastReason = result.reason === 'grey-globe'
      ? 'grey-globe (dominio senza favicon)'
      : result.reason || lastReason;
  }
  return { found: false, domain, reason: lastReason };
}
