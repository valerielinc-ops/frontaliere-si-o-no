/**
 * Crawler synthesis — turn a traced candidate into a runnable crawler spec.
 *
 * A spec, not a hand-written parser. The extraction cascade already reads
 * JSON-LD, microdata and templated listings generically, so what a new employer
 * actually needs is a small declarative record: where to start, how the listing
 * was recognised, and how to reach a detail page. Emitting a spec instead of
 * code is what makes onboarding hundreds of micro-employers tractable — and it
 * keeps every one of them auditable in a diff.
 *
 * Specs are learned from the LIVE page, not assumed: the synthesiser fetches the
 * careers URL, runs the cascade, and records which rung fired and what it saw.
 * A spec that yields nothing is never written — a crawler that has never
 * extracted a vacancy is worse than no crawler, because the health monitor will
 * carry it as broken for ever.
 */
import { politeFetch } from './polite-fetch.mjs';
import { extractVacancies, textOf } from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { normalizeHost, registrableDomain, tenantLabel } from './registrable.mjs';

/**
 * @typedef {Object} CrawlerSpec
 * @property {string} companyKey
 * @property {string} companyName
 * @property {string} companyHost
 * @property {string} platform            registrable domain of the ATS, '' when self-hosted
 * @property {'jsonld'|'microdata'|'template'} mode
 * @property {string[]} seedUrls
 * @property {string} [detailTemplate]    URL template shared by the vacancy links
 * @property {number} sampleVacancyCount
 * @property {string[]} sampleTitles
 * @property {string} [canton]
 * @property {string} sourceLang
 * @property {string} learnedAt
 */

/** Rough language read of a page, enough to set `sourceLang` on the jobs. */
export function detectPageLang(html = '') {
  const declared = /<html[^>]*\blang\s*=\s*["']([a-z]{2})/i.exec(html)?.[1];
  if (declared && ['it', 'de', 'fr', 'en'].includes(declared)) return declared;
  const t = textOf(html).toLowerCase().slice(0, 6000);
  const score = {
    it: (t.match(/\b(e|di|il|la|per|con|del|della|lavoro|azienda|nostra)\b/g) || []).length,
    de: (t.match(/\b(und|der|die|das|für|mit|bei|unsere|stellen|arbeit)\b/g) || []).length,
    fr: (t.match(/\b(et|le|la|les|pour|avec|notre|emploi|entreprise)\b/g) || []).length,
    en: (t.match(/\b(and|the|for|with|our|job|company|apply)\b/g) || []).length,
  };
  return Object.entries(score).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * The longest common URL template across a set of vacancy links — the pattern a
 * validator can later use to tell "this link is a vacancy" from "this link is
 * the About page".
 *
 * @param {string[]} urls
 * @returns {string}
 */
export function commonUrlTemplate(urls = []) {
  const paths = urls.map((u) => { try { return new URL(u).pathname; } catch { return ''; } }).filter(Boolean);
  if (paths.length < 2) return paths[0] || '';
  const split = paths.map((p) => p.split('/'));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    out.push(split.every((s) => s[i] === seg) ? seg : '*');
  }
  return out.join('/');
}

/**
 * A crawler key that is stable, filesystem-safe and unique enough to sit
 * alongside the 580-odd existing crawler keys.
 *
 * @param {{ name?: string, tenantHost?: string, domain?: string }} candidate
 * @returns {string}
 */
export function crawlerKeyFor(candidate) {
  const fromHost = candidate.tenantHost ? tenantLabel(candidate.tenantHost) : '';
  // Un tenant id opaco (`recruitingapp-2862`) e' una chiave pessima: non dice
  // di chi e' il crawler, e finisce nel nome dei file, nel manifest e nei
  // gruppi di workflow. Quando il vendor usa id anonimi, il nome dell'azienda
  // — che la pagina del tenant ci ha gia' dato — e' l'unica cosa leggibile.
  const opaqueLabel = /^[a-z]*[-_]?\d{2,}$/i.test(fromHost) || /^\d/.test(fromHost);
  const preferred = opaqueLabel && candidate.name ? candidate.name : fromHost;
  const base = preferred || candidate.domain?.split('.')[0] || candidate.name || 'unknown';
  return String(base)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/**
 * Learn a spec by crawling the candidate's careers page for real.
 *
 * @param {Record<string, any>} candidate
 * @returns {Promise<{ spec: CrawlerSpec|null, reason?: string, vacancies: any[] }>}
 */
export async function synthesizeSpec(candidate) {
  const seed = candidate.careersUrl || (candidate.tenantHost ? `https://${candidate.tenantHost}/` : null)
    || (candidate.domain ? `https://${candidate.domain}/` : null);
  if (!seed) return { spec: null, reason: 'nessun URL di partenza', vacancies: [] };

  const res = await politeFetch(seed);
  if (!res.ok) return { spec: null, reason: `seed irraggiungibile (${res.status})`, vacancies: [] };

  const links = extractLinks(res.body, res.url);
  const { vacancies, via } = extractVacancies(res.body, res.url, links);
  if (!vacancies.length) return { spec: null, reason: 'nessun annuncio estratto dal seed', vacancies: [] };

  const host = normalizeHost(new URL(res.url).hostname);
  const spec = {
    companyKey: crawlerKeyFor(candidate),
    companyName: candidate.name || tenantLabel(host) || host,
    companyHost: host,
    platform: candidate.platform || (registrableDomain(host) === registrableDomain(candidate.domain || '') ? '' : registrableDomain(host)),
    mode: via,
    seedUrls: [res.url],
    detailTemplate: commonUrlTemplate(vacancies.map((v) => v.url)) || undefined,
    sampleVacancyCount: vacancies.length,
    sampleTitles: vacancies.slice(0, 5).map((v) => v.title),
    canton: candidate.canton || undefined,
    sourceLang: detectPageLang(res.body),
    learnedAt: new Date().toISOString(),
  };
  return { spec, vacancies };
}

/**
 * Run a spec: fetch its seeds and return the vacancies it yields today.
 * This is both the crawler itself and the thing the validator re-runs.
 *
 * @param {CrawlerSpec} spec
 * @returns {Promise<{ vacancies: any[], errors: string[] }>}
 */
export async function runSpec(spec) {
  /** @type {any[]} */
  const all = [];
  const errors = [];
  for (const seed of spec.seedUrls) {
    const res = await politeFetch(seed);
    if (!res.ok) { errors.push(`${seed}: HTTP ${res.status}`); continue; }
    const links = extractLinks(res.body, res.url);
    const { vacancies } = extractVacancies(res.body, res.url, links);
    for (const v of vacancies) {
      all.push({
        ...v,
        company: v.company || spec.companyName,
        companyKey: spec.companyKey,
        companyDomain: spec.companyHost,
        sourceLang: spec.sourceLang,
        canton: spec.canton,
      });
    }
  }
  // Same vacancy can surface from two seeds; key on URL.
  const seen = new Set();
  const unique = all.filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
  return { vacancies: unique, errors };
}
