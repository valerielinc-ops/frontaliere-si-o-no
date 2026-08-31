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
import { extractVacancies, isSufficientVacancyDescription, textOf } from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { resolveDetailOrListingSwissGeography } from './location-evidence.mjs';
import { normalizeHost, registrableDomain, tenantLabel } from './registrable.mjs';
import { createSpecUrlPolicy } from './public-fetch-policy.mjs';

/**
 * @typedef {Object} CrawlerSpec
 * @property {string} companyKey
 * @property {string} companyName
 * @property {string} companyHost
 * @property {string} platform            registrable domain of the ATS, '' when self-hosted
 * @property {'jsonld'|'microdata'|'template'} mode
 * @property {string[]} seedUrls
 * @property {string[]} [allowedDetailOrigins] Exact extra origins reviewed for cross-origin ATS/CDN detail URLs
 * @property {string} [detailTemplate]    URL template shared by the vacancy links
 * @property {boolean} [detailEnrichment] Fetch detail pages for authoritative fields
 * @property {number} [detailFetchWorkers] Maximum concurrent detail fetches
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
 * True when `err` is the kind of malformed-input failure SYNTHESIZE is meant
 * to isolate per-candidate (a `%E9` Latin-1 escape, an unparseable URL) rather
 * than a genuine programming bug. The caller uses this to decide whether a
 * rejected candidate is expected noise or a regression that deserves to stay
 * visible instead of vanishing into "candidato rifiutato".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isExpectedSynthesisError(err) {
  // `instanceof` da solo non basta: un URIError attraversato da un realm o
  // ri-lanciato da una lib puo' perderlo. Ma il solo `.name` e' troppo largo —
  // una libreria che sovrascrive `.name` su un errore qualsiasi verrebbe
  // riassorbita come rumore atteso, cioe' proprio il bug che questa distinzione
  // vuole rendere visibile. Quindi: instanceof, oppure un vero Error il cui
  // nome E' URIError.
  if (err instanceof URIError) return true;
  return err instanceof Error && err.name === 'URIError';
}

/**
 * Learn a spec by crawling the candidate's careers page for real.
 *
 * @param {Record<string, any>} candidate
 * @returns {Promise<{ spec: CrawlerSpec|null, reason?: string, vacancies: any[] }>}
 */
export async function synthesizeSpec(candidate, runtime = {}) {
  const seed = candidate.careersUrl || (candidate.tenantHost ? `https://${candidate.tenantHost}/` : null)
    || (candidate.domain ? `https://${candidate.domain}/` : null);
  if (!seed) return { spec: null, reason: 'nessun URL di partenza', vacancies: [] };

  const res = await politeFetch(seed, {
    fetchImpl: runtime.fetchImpl,
    lookupImpl: runtime.lookupImpl,
    sleepImpl: runtime.sleepImpl,
  });
  if (!res.ok) return { spec: null, reason: `seed irraggiungibile (${res.status})`, vacancies: [] };

  const links = extractLinks(res.body, res.url);
  const { vacancies, via } = extractVacancies(res.body, res.url, links);
  if (!vacancies.length) return { spec: null, reason: 'nessun annuncio estratto dal seed', vacancies: [] };

  // A synthesised spec must not silently learn an unreviewed ATS/CDN origin.
  // Existing promoted specs may name `allowedDetailOrigins` explicitly, but
  // autonomous discovery has no evidence that employer.example is entitled to
  // make us fetch ats.example. Reject the candidate instead of passing a gate
  // that production later (correctly) reduces to zero rows.
  const seedOrigin = new URL(res.url).origin;
  const crossOriginVacancy = vacancies.find((vacancy) => {
    try { return new URL(vacancy.url).origin !== seedOrigin; } catch { return true; }
  });
  if (crossOriginVacancy) {
    return {
      spec: null,
      reason: `origine dettaglio non autorizzata: ${String(crossOriginVacancy.url || '').slice(0, 160)}`,
      vacancies: [],
    };
  }

  const host = normalizeHost(new URL(res.url).hostname);
  const listingNeedsDetail = vacancies.some(
    (vacancy) => !resolveDetailOrListingSwissGeography({}, vacancy).geography
      || !isSufficientVacancyDescription(vacancy.description),
  );
  /** @type {CrawlerSpec} */
  const spec = {
    companyKey: crawlerKeyFor(candidate),
    companyName: candidate.name || tenantLabel(host) || host,
    companyHost: host,
    platform: candidate.platform || (registrableDomain(host) === registrableDomain(candidate.domain || '') ? '' : registrableDomain(host)),
    mode: /** @type {'jsonld'|'microdata'|'template'} */ (via),
    seedUrls: [res.url],
    detailTemplate: commonUrlTemplate(vacancies.map((v) => v.url)) || undefined,
    detailEnrichment: via === 'template' || listingNeedsDetail,
    detailFetchWorkers: 4,
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
export async function runSpec(spec, runtime = {}) {
  /** @type {any[]} */
  const all = [];
  const errors = [];
  const urlPolicy = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  try {
    for (const seed of spec.seedUrls) {
      const res = await politeFetch(seed, {
        urlPolicy,
        dispatcher: urlPolicy.dispatcher,
        fetchImpl: runtime.fetchImpl,
        sleepImpl: runtime.sleepImpl,
      });
      if (!res.ok) { errors.push(`${seed}: HTTP ${res.status}`); continue; }
      const links = extractLinks(res.body, res.url);
      const { vacancies } = extractVacancies(res.body, res.url, links);
      for (const v of vacancies) {
        try { await urlPolicy(v.url); } catch {
          errors.push(`${v.url}: origine dettaglio non autorizzata`);
          continue;
        }
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
  } finally {
    await urlPolicy.dispatcher.close();
  }
  // Same vacancy can surface from two seeds; key on URL.
  const seen = new Set();
  const unique = all.filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
  return { vacancies: unique, errors };
}
