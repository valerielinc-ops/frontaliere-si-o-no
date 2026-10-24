/**
 * Company logo probe — verifies a candidate's own domain actually serves a
 * recognisable logo, BEFORE the candidate is allowed into production.
 *
 * Unlike `scripts/download-missing-company-logos.mjs` (which must GUESS a
 * domain for an arbitrary company name by trying several candidate domains),
 * a prospector candidate already carries the employer's domain. So this is a
 * direct verification against a known domain, not a multi-domain guess.
 *
 * The probe reads only assets the employer's own domain declares or serves: the
 * icons and logo images its homepage names (`apple-touch-icon`, `rel=icon`, a
 * logo `<img>`, a JSON-LD `logo`), then `/favicon.ico`. Reading only
 * `/favicon.ico` refused every site that declares its icon elsewhere — 31 of
 * 65 validations on 2026-10-23 — while a 16 px favicon passed. The verified
 * URL is returned as `source`, so promotion can register that exact asset
 * instead of a guess.
 *
 * A proxy or third-party favicon CDN is NOT read: a positive result there is
 * unrelated to an asset we can mirror to our stable CDN. Clearbit is NOT used
 * either — its logo CDN is defunct (see the guard comment in
 * `services/jobDataNormalization.ts`).
 */
import { fetchVerifiedLogo } from '../company-logo-audit.mjs';
import { extractIconLinks, extractOfficialLogoImages } from '../../download-missing-company-logos.mjs';
import { politeFetch } from './polite-fetch.mjs';
import { normalizeHost, registrableDomain } from './registrable.mjs';

const FETCH_TIMEOUT_MS = 10_000;
/** Declared assets tried per homepage, so one page full of logos costs little. */
const MAX_DECLARED_ASSETS = 6;

/**
 * The domain whose logo identifies the employer. For a hosted ATS tenant the
 * crawler host is the vendor's (`my.jobalino.ch`, `apply.refline.ch`), and its
 * favicon is the vendor's brand: the employer's own domain is used instead,
 * and when only the vendor's is known there is no employer logo to verify.
 *
 * @param {{ domain?: string, platform?: string }|null|undefined} candidate
 * @param {{ companyHost?: string, platform?: string }} spec
 * @returns {string}
 */
export function employerLogoDomain(candidate, spec = {}) {
  const host = normalizeHost(String(spec.companyHost || ''));
  const hosted = Boolean(candidate?.platform || spec.platform);
  const vendor = hosted ? registrableDomain(host) : '';
  const own = normalizeHost(String(candidate?.domain || ''));
  if (own && registrableDomain(own) !== vendor) return own;
  return hosted ? '' : host;
}

function homepageUrls(domain) {
  const urls = [`https://${domain}/`];
  if (!/^www\./i.test(domain)) urls.push(`https://www.${domain}/`);
  return urls;
}

function officialFaviconUrls(domain) {
  return homepageUrls(domain).map((url) => `${url}favicon.ico`);
}

/**
 * @param {string} host bare hostname, e.g. `'lonza.com'`
 * @param {{ fetchPage?: typeof politeFetch, fetchImage?: typeof fetchVerifiedLogo }} [runtime]
 * @returns {Promise<{ found: boolean, domain?: string, size?: number, source?: string, qualityStatus?: string, reason?: string }>}
 */
export async function probeCompanyLogo(host, runtime = {}) {
  const domain = normalizeHost(String(host || '').trim());
  if (!domain) return { found: false, reason: 'nessun dominio dell\'azienda (solo quello del vendor ATS)' };
  const fetchPage = runtime.fetchPage || politeFetch;
  const fetchImage = runtime.fetchImage || ((url) => fetchVerifiedLogo(url, { timeoutMs: FETCH_TIMEOUT_MS }));

  let fallback = null;
  let lastReason = 'logo non verificato';
  const tried = new Set();
  const tryImage = async (url) => {
    if (tried.has(url)) return null;
    tried.add(url);
    const result = await fetchImage(url).catch((error) => ({ status: 'broken', reason: String(error?.message || error) }));
    if (result.status !== 'valid') {
      lastReason = result.reason === 'grey-globe' ? 'grey-globe (dominio senza favicon)' : result.reason || lastReason;
      return null;
    }
    return {
      found: true,
      domain,
      size: result.bytes,
      source: result.url || url,
      qualityStatus: result.qualityStatus || 'unverified',
    };
  };

  for (const pageUrl of homepageUrls(domain)) {
    const page = await fetchPage(pageUrl).catch(() => null);
    if (!page?.ok || !page.body) continue;
    const baseUrl = page.url || pageUrl;
    const declared = [
      ...extractIconLinks(page.body, baseUrl, { allowGenericFavicon: true }),
      ...extractOfficialLogoImages(page.body, baseUrl, registrableDomain(domain) || domain),
    ].slice(0, MAX_DECLARED_ASSETS);
    for (const url of declared) {
      const hit = await tryImage(url);
      if (hit?.qualityStatus === 'good') return hit;
      fallback ||= hit;
    }
    // One homepage that answered is the employer's statement of its assets;
    // the `www.` variant is only a fallback for a bare domain that does not.
    break;
  }
  if (fallback) return fallback;

  for (const url of officialFaviconUrls(domain)) {
    const hit = await tryImage(url);
    if (hit) return hit;
  }
  return { found: false, domain, reason: lastReason };
}
