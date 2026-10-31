/**
 * Famiglia `comuni-ticino`: i concorsi pubblicati dai Comuni ticinesi.
 *
 * Un'entrata per Comune in data/ticino-comuni-registry.json, con il Comune come
 * datore di ogni annuncio; lo stesso file dichiara perche' i Comuni non coperti
 * non lo sono. Nel manifest c'e' un crawler solo: i gruppi di workflow hanno un
 * tetto di 480 KB (GitHub ne rifiuta 512) e ogni voce ne costa circa 16, quindi
 * 67 voci non ci stanno, e il tetto non si alza. Un Comune guasto non ferma gli
 * altri e non perde gli annunci: quelli che il giro non rivede restano nella
 * grazia dei job mancanti.
 *
 * Le regole sul bando sono in ticino-comuni-notice.mjs, gli adapter in
 * ticino-comuni-sources.mjs, il rispetto di robots.txt in
 * ticino-comuni-polite-client.mjs.
 *
 * Il corpo dell'annuncio e' solo il testo ufficiale del bando (PDF): nessuna
 * riga scritta dal crawler. Un PDF scansionato, senza strato di testo, non si
 * pubblica: non c'e' niente di verificabile da mostrare.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAuthoritativeEmptySnapshot,
  markAuthoritativeEmptySnapshot,
} from './authoritative-empty-snapshot.mjs';
import { runStandardCrawlerPipeline } from './crawler-template.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './source-body-failure.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import {
  classifyNoticeTitle,
  dropAttachmentsOfPublishedNotices,
  extractDeadline,
  extractNoticeDate,
  isNoticeOpen,
  isTooOldToOpen,
  resolveNoticeIssuer,
  roleTitleFromNotice,
} from './ticino-comuni-notice.mjs';
import {
  RobotsDisallowedError,
  TICINO_COMUNI_USER_AGENT,
  createPoliteClient,
} from './ticino-comuni-polite-client.mjs';
import {
  ASSOLO_TEXT_QUERY,
  CITYOS_LIST_SELECTOR,
  MAX_ASSOLO_PAGES,
  assoloListingUrl,
  parseAssoloListing,
  parseCityOsDetail,
  parseCityOsList,
  parseDedicatedPage,
} from './ticino-comuni-sources.mjs';
import { inferEmploymentType, isTitleTooGeneric, slugify } from './ticino-comuni-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'ticino-comuni-registry.json');
const REFUSED_STATUS = new Set([401, 403, 406, 429, 451]);

export const TICINO_COMUNI_KEY = 'comuni-ticino';
export const TICINO_COMUNI_COMPANY_NAME = 'Comuni ticinesi';
export const MAX_NOTICES_PER_RUN = 12;
/** Host diversi in parallelo: la pausa per host resta quella del client. */
export const COMUNI_CONCURRENCY = 8;

export function loadTicinoComuniRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

export function coveredTicinoComuni(registry = loadTicinoComuniRegistry()) {
  return registry.comuni.filter((entry) => entry.status === 'covered');
}

function hostsOf(entry) {
  return [entry.domain, ...(entry.extraHosts || [])].map((host) => host.toLowerCase());
}

export function isTrustedComuneUrl(entry, rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && hostsOf(entry).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

class ListingRefusedError extends Error {
  constructor(url, status) {
    super(`${url} ha risposto ${status}`);
    this.listingRefused = true;
  }
}

async function readListingPage(client, url) {
  const response = await client.fetch(url);
  if (REFUSED_STATUS.has(response.status)) throw new ListingRefusedError(url, response.status);
  if (!response.ok) throw new Error(`HTTP ${response.status} leggendo ${url}`);
  return response.text();
}

/**
 * Il browser di una pagina costruita lato client. Si apre solo per i Comuni che
 * lo dichiarano: Playwright non e' una dipendenza degli altri.
 */
export function createPageRenderer() {
  let browser = null;
  return {
    async render(url, { waitForSelector }) {
      if (!browser) {
        const { chromium } = await import('playwright');
        browser = await chromium.launch();
      }
      const page = await browser.newPage({ userAgent: TICINO_COMUNI_USER_AGENT });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForSelector(waitForSelector, { timeout: 30_000, state: 'attached' });
        return await page.content();
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser?.close();
      browser = null;
    },
  };
}

async function readRenderedCityOs(listing, client, renderer) {
  try {
    await client.reserve(listing.url);
    const html = await renderer.render(listing.url, { waitForSelector: `${CITYOS_LIST_SELECTOR}:not(.loading)` });
    const parsed = parseCityOsList(html, { baseUrl: listing.url });
    if (!parsed.recognized) return [parsed];
    const rows = [];
    for (const row of parsed.rows) {
      if (classifyNoticeTitle(row.title) !== 'job') continue;
      await client.reserve(row.url);
      const detail = await renderer.render(row.url, { waitForSelector: 'main a[href$=".pdf"]' });
      const pdf = parseCityOsDetail(detail, { baseUrl: row.url })
        .find((candidate) => classifyNoticeTitle(candidate.title) !== 'form');
      if (pdf) rows.push({ title: row.title, date: row.date, url: pdf.url });
    }
    return [{ ...parsed, rows }];
  } finally {
    await renderer.close();
  }
}

/** Tutte le viste dell'albo o della pagina dedicata di un Comune. */
async function readComuneListing(entry, client, renderer) {
  const { listing } = entry;
  if (listing.type === 'rendered-cityos') return readRenderedCityOs(listing, client, renderer);
  if (listing.type === 'page') {
    const html = await readListingPage(client, listing.url);
    return [parseDedicatedPage(html, { ...listing, baseUrl: listing.url })];
  }
  const views = [{ text: ASSOLO_TEXT_QUERY, category: false }];
  if (listing.catParam || listing.catinv) views.unshift({ text: '', category: true });
  const results = [];
  for (const view of views) {
    for (let page = 1; page <= MAX_ASSOLO_PAGES; page += 1) {
      const url = assoloListingUrl(listing, { ...view, page });
      const html = await readListingPage(client, url);
      const parsed = parseAssoloListing(html, {
        baseUrl: listing.url,
        fric: listing.fric,
        page,
        ...(view.category ? { catParam: listing.catParam, catId: listing.catId } : {}),
      });
      // Oltre la prima pagina non tutti gli albi rispondono via GET, e la ricerca
      // di Muralto rende un formato suo: quello che si e' letto resta valido,
      // purche' la categoria sia stata confermata, e resta la grazia per il resto.
      if (!parsed.recognized && (page > 1 || (results.length > 0 && !view.category))) break;
      results.push(parsed);
      if (!parsed.hasNextPage) break;
    }
  }
  return results;
}

function storedJobByUrl(existingJobs, url) {
  return (existingJobs || []).find((job) => job?.url === url || job?.pdfUrl === url) || null;
}

function buildComuneJob(entry, { notice, title, text, deadline, publishedIso, now }) {
  const description = buildPdfBackedDescription({ pdfText: text });
  const sourceLang = detectLang(description || title, 'it');
  const urlHash = createHash('sha256').update(notice.url).digest('hex').slice(0, 10);
  const slug = slugify(title, slugify(entry.municipality));
  const employmentType = inferEmploymentType(notice.title, text.slice(0, 1500));
  return {
    id: `${entry.key}-${urlHash}`,
    slug,
    slugByLocale: { [sourceLang]: slug },
    company: entry.company,
    companyKey: TICINO_COMUNI_KEY,
    municipalityKey: entry.key,
    companyDomain: entry.domain,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    location: entry.municipality,
    canton: 'TI',
    addressLocality: entry.addressLocality || entry.municipality,
    addressRegion: 'TI',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: entry.postalCode,
    streetAddress: entry.streetAddress,
    category: 'public-admin',
    sector: 'Amministrazione pubblica',
    employmentType,
    contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
    currency: 'CHF',
    featured: false,
    ...sourcePostingDateFields(publishedIso, now),
    ...(deadline ? { validThrough: deadline } : {}),
    url: notice.url,
    pdfUrl: notice.url,
    applyUrl: notice.url,
    source: `${entry.company} Dedicated Parser (albo + PDF)`,
    sourceLang,
    crawledAt: new Date(now).toISOString(),
  };
}

function reportStampedEmpty(entry, evidence) {
  const jobs = markAuthoritativeEmptySnapshot([], `${entry.company}: ${evidence}`);
  Object.defineProperty(jobs, 'fetchOutcome', { value: 'ok', enumerable: false });
  return jobs;
}

/**
 * @param {object} entry voce del registro
 * @param {{
 *   existingJobs?: object[],
 *   client?: ReturnType<typeof createPoliteClient>,
 *   extractPdf?: typeof extractPdfJobContentFromUrl,
 *   renderer?: ReturnType<typeof createPageRenderer>,
 *   now?: Date,
 * }} [options]
 */
export async function fetchTicinoComuneJobs(entry, {
  existingJobs = [],
  client = createPoliteClient(),
  extractPdf = extractPdfJobContentFromUrl,
  renderer = createPageRenderer(),
  now = new Date(),
} = {}) {
  console.log(`🔍 ${entry.company}: ${entry.listing.url}`);

  let views;
  try {
    views = await readComuneListing(entry, client, renderer);
  } catch (error) {
    if (error?.listingRefused) {
      console.warn(`  ⛔ ${entry.company}: ${error.message}. Nessun aggiramento: stop.`);
      return { jobs: [], fetchOutcome: 'anti_bot_block' };
    }
    if (error instanceof RobotsDisallowedError) {
      console.warn(`  ⛔ ${entry.company}: ${error.message}. Stop.`);
      return { jobs: [], fetchOutcome: 'selector_miss' };
    }
    throw error;
  }
  const unrecognized = views.filter((view) => !view.recognized);
  if (unrecognized.length > 0) {
    console.warn(`  ⚠️ ${entry.company}: pagina non riconosciuta (${unrecognized[0].reason}).`);
    return { jobs: [], fetchOutcome: 'selector_miss' };
  }

  const rows = [...new Map(views.flatMap((view) => view.rows).map((row) => [row.url, row])).values()];
  const candidates = dropAttachmentsOfPublishedNotices(
    rows
      .map((row) => ({ ...row, kind: classifyNoticeTitle(row.title) }))
      .filter((row) => (row.kind === 'job' || row.kind === 'attachment') && !isTooOldToOpen(row.date, now)),
  );
  console.log(`  📋 ${rows.length} documenti, ${candidates.length} candidati a concorso di assunzione`);

  const jobs = [];
  const sourceBodyFailures = [];
  const skipped = { scansionati: 0, robots: 0, altroEnte: 0, chiusi: 0 };

  for (const notice of candidates.slice(0, MAX_NOTICES_PER_RUN)) {
    const verdict = await client.canFetch(notice.url);
    if (!verdict.allowed) {
      skipped.robots += 1;
      console.log(`  🚫 robots.txt vieta il bando: ${notice.title}`);
      continue;
    }
    const stored = storedJobByUrl(existingJobs, notice.url);
    const storedBody = meetsSourceBodyFloor(stored?.description) ? stored.description : '';
    let text = storedBody;
    if (!text) {
      const pdf = await extractPdf(notice.url, { fetchImpl: client.fetch, proxyRescue: false });
      if (pdf?.extractionFailed && pdf?.httpStatus === 200) {
        skipped.scansionati += 1;
        console.log(`  🖨️ PDF senza testo: ${notice.title}`);
        continue;
      }
      if (pdf?.error || pdf?.extractionFailed) {
        const message = pdf.error || 'PDF non leggibile';
        console.warn(`  ⚠️ ${notice.title}: ${message}`);
        sourceBodyFailures.push({ title: notice.title, url: notice.url, reason: SOURCE_BODY_FAILURE_REASON, message });
        continue;
      }
      text = pdf?.thin ? '' : String(pdf?.rawText || pdf?.text || '');
      if (!text) {
        skipped.scansionati += 1;
        continue;
      }
    }

    const publishedIso = notice.date || extractNoticeDate(text);
    const deadline = extractDeadline(text, { publishedIso });
    const issuer = resolveNoticeIssuer({ title: notice.title, text, entry });
    if (!issuer.own) {
      skipped.altroEnte += 1;
      console.log(`  🏢 Non e' del Comune (${issuer.reason}): ${notice.title}`);
      continue;
    }
    if (!isNoticeOpen({ deadline, publishedIso }, now)) {
      skipped.chiusi += 1;
      console.log(`  ⏭️ Chiuso (${deadline || publishedIso || 'senza date'}): ${notice.title}`);
      continue;
    }
    const roleTitle = roleTitleFromNotice(notice.title);
    if (isTitleTooGeneric(roleTitle)) {
      console.log(`  ⏭️ Titolo non informativo: ${notice.title}`);
      continue;
    }
    jobs.push(buildComuneJob(entry, { notice, title: roleTitle, text, deadline, publishedIso, now }));
    console.log(`  ✅ ${roleTitle} (scadenza ${deadline || 'non indicata'})`);
  }

  console.log(`  📊 ${entry.company}: ${jobs.length} aperti, esclusi ${JSON.stringify(skipped)}`);
  const unresolved = skipped.scansionati + skipped.robots + sourceBodyFailures.length;
  if (jobs.length === 0 && unresolved === 0) {
    return reportStampedEmpty(entry, `${rows.length} documenti letti, nessun concorso di assunzione aperto`);
  }
  return {
    jobs,
    discoveredCount: candidates.length,
    fetchOutcome: jobs.length > 0 ? 'ok' : 'filtered_empty',
    sourceBodyFailures,
  };
}

/** Un concorso scaduto non deve sopravvivere nella grazia dei job mancanti. */
export function dropExpiredStoredJobs(jobs, now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return jobs.filter((job) => !job?.validThrough || String(job.validThrough).slice(0, 10) >= today);
}

/**
 * Tutti i Comuni coperti. L'esito di un Comune resta suo: un guasto si conta e
 * si riporta, e lo zero autorevole della famiglia vale solo se ogni Comune ha
 * provato il proprio.
 */
export async function fetchAllTicinoComuniJobs({
  existingJobs = [],
  comuni = coveredTicinoComuni(),
  fetchComune = fetchTicinoComuneJobs,
  client = createPoliteClient(),
  extractPdf = extractPdfJobContentFromUrl,
  renderer = createPageRenderer(),
  concurrency = COMUNI_CONCURRENCY,
  now = new Date(),
} = {}) {
  const queue = [...comuni];
  const outcomes = new Map();
  const jobs = [];
  const sourceBodyFailures = [];
  let discoveredCount = 0;
  let provenEmpty = 0;

  async function worker() {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try {
        const result = await fetchComune(entry, { existingJobs, client, extractPdf, renderer, now });
        if (isAuthoritativeEmptySnapshot(result)) {
          provenEmpty += 1;
          outcomes.set(entry.key, 'ok');
          continue;
        }
        jobs.push(...result.jobs);
        sourceBodyFailures.push(...(result.sourceBodyFailures || []));
        discoveredCount += result.discoveredCount || 0;
        outcomes.set(entry.key, result.fetchOutcome);
      } catch (error) {
        console.warn(`  ⚠️ ${entry.company}: ${error?.message || error}`);
        outcomes.set(entry.key, 'connection_error');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const tally = {};
  for (const outcome of outcomes.values()) tally[outcome] = (tally[outcome] || 0) + 1;
  console.log(`\n📊 Comuni: ${JSON.stringify(tally)}; annunci aperti ${jobs.length}`);
  const failed = [...outcomes].filter(([, outcome]) => outcome !== 'ok' && outcome !== 'filtered_empty');
  if (failed.length > 0) console.warn(`  ⚠️ Comuni non letti: ${failed.map(([key]) => key).join(', ')}`);

  if (jobs.length === 0 && provenEmpty === comuni.length) {
    const empty = markAuthoritativeEmptySnapshot([], `${provenEmpty} Comuni letti, nessun concorso di assunzione aperto`);
    Object.defineProperty(empty, 'fetchOutcome', { value: 'ok', enumerable: false });
    return empty;
  }
  const everyComuneFailed = outcomes.size > 0 && failed.length === outcomes.size;
  return {
    jobs,
    discoveredCount: discoveredCount + provenEmpty,
    fetchOutcome: jobs.length > 0 ? 'ok' : (everyComuneFailed ? 'connection_error' : 'filtered_empty'),
    sourceBodyFailures,
  };
}

export function runTicinoComuniCrawler() {
  const comuni = coveredTicinoComuni();
  return runStandardCrawlerPipeline({
    companyKey: TICINO_COMUNI_KEY,
    companyLabel: TICINO_COMUNI_COMPANY_NAME,
    root: ROOT,
    fetchJobs: ({ existingJobs }) => fetchAllTicinoComuniJobs({ existingJobs, comuni }),
    isCompanyJob: (job) => job?.companyKey === TICINO_COMUNI_KEY,
    isTrustedDomain: (url) => comuni.some((entry) => isTrustedComuneUrl(entry, url)),
    defaultSourceLang: 'it',
    prepareExistingJobs: (jobs) => dropExpiredStoredJobs(jobs),
  }).catch((error) => {
    console.error(`❌ ${TICINO_COMUNI_COMPANY_NAME} crawler failed: ${error?.message || error}`);
    process.exit(1);
  });
}
